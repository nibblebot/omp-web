---
title: Fan-out prompting
description: "Send one prompt to many session daemons at once, with automatic waking, parallel turns, and correlated results when you wait."
---

`omp-web prompt` sends a prompt to every session daemon a selector matches. Targets are woken on demand, different session daemons run their turns in parallel, prompts to the same session daemon are serialized, and `--wait` correlates each target's own turn into a result you can read per session daemon. This is the terminal path for asking the same question of many worktrees or many machines; the browser has no fan-out prompt surface.

The fleet must be running on the control port; see [CLI overview](/cli/overview/).

## The command

```sh
omp-web prompt <selector> <text> [--wait <ms>]
```

The selector picks the targets, using the forms in [Select multiple session daemons](/cli/selectors/). The text is everything after the selector, joined with single spaces, so quote it as one shell argument:

```sh
omp-web prompt label:role=review "Summarize the open action items in this checkout."
omp-web prompt project:app --wait 300000 "Run the test suite and report only failures."
```

Words beginning with `--` are parsed as flags wherever they appear, so keep the prompt in one quoted argument rather than letting a `--word` reach the parser unquoted.

The selector is resolved once, when the command runs. A selector that matches nothing fails with exit 1 before anything is sent.

## Fire-and-forget

Without `--wait`, the fleet accepts the dispatch and returns immediately:

```sh
omp-web prompt all "Record the current branch name in NOTES.md"
```

- The command prints the ids it submitted to and exits 0.
- Each prompt is then delivered in the background. The turn runs as a normal agent turn in that session, so it appears in the transcript and in the browser like any prompt you typed there.
- The background outcomes are discarded: a target that could not be woken, a rejected prompt, or a turn that never finishes produces no output on this command or in the fleet log. Fire-and-forget confirms acceptance, not completion. Use `--wait` when you need to know what happened, or read the transcripts afterwards.

## Awaited results

`--wait <ms>` sets a per-target budget in milliseconds. The fleet waits for each target's turn and the command prints one block per target, in the order the selector matched:

```text
== d2 ==
The suite passes, with two skipped tests.
== d3 ==
error: timeout
```

- A block starts with the session daemon's id in `== d2 ==` form, followed by the last assistant message text of that session daemon's turn, or by an `error:` line explaining why that target did not produce one.
- The budget applies to each target separately, not to the command as a whole, so a run against five session daemons can take up to the budget even after the first four finish.
- The exit status is 0 even when individual targets time out or fail. Scripts must read the blocks. This is the one place where success is not encoded in the exit status; see [CLI overview](/cli/overview/).
- `--wait` requires a numeric value. A missing value is a flag error, and a value that is not a number is refused, both with exit 1.

## Waking targets

Before sending, the fleet makes each target ready, which is what lets a prompt revive a checkout you have not touched since it went to sleep:

- A local session daemon that is not `ready`, including one that is asleep or in `error`, is respawned, resuming its last session file, and the fleet waits up to 60 seconds for it to become ready.
- A local session daemon whose connection dropped behind a stale ready status is only redialed, which avoids killing a healthy process.
- A remote session daemon is redialed the same way.

If a target does not become ready inside that window, it comes back as a per-target error under `--wait`, and a fire-and-forget run reports nothing about it. The `--wait` budget starts after the target is ready, so the worst case for one target is the readiness wait plus your budget. Because waking resumes the last session, a fan-out prompt continues the conversation that row was already on rather than starting fresh; see [Session persistence](/concepts/session-persistence/).

## Parallelism and ordering

Two rules describe everything you will observe:

- **Different session daemons run concurrently.** Every matched target is prompted at the same time, so a fan-out across ten worktrees takes about as long as its slowest turn, not the sum of all turns.
- **One turn at a time per session daemon.** A single session daemon hosts one live session, so its prompts are serialized. That also holds across commands: a second fan-out that targets a session daemon already handling a fan-out prompt waits its turn instead of interleaving.

Per-target results are collected independently, so one failure or timeout never cancels the others.

## Result correlation

Each awaited prompt settles on its own turn, not on whatever that session daemon happens to be doing:

- The result belongs to the call the fleet sent. A turn started in the browser at the same time cannot complete your prompt, and a failed prompt call for another client cannot fail yours.
- The returned text is the last assistant message of that turn, and the result also carries the turn's usage figures for the control API; the command prints only the text.
- A turn that ends in an abort reports `aborted`, a rejected call reports the session daemon's error message, and an unanswered call reports `timeout` after the budget elapses.

The practical consequence is that `--wait` output is trustworthy per session daemon, even on a busy fleet where browsers are also attached to the same session daemons.

## Choosing targets

- Labels are the most stable handle for automation: set them when starting a session daemon with `omp-web spawn --label k=v`, then prompt `label:k=v`.
- `project:name` addresses every session daemon of one checkout family, including linked worktrees whose project field matches.
- `all` includes every local and remote row, asleep or not. Prefer a narrower selector when a prompt has side effects.
- A session daemon id always names the same row, but rows come and go as you add and remove them, so a long-lived script should prefer labels or `project:` over ids.

## Related

- [CLI overview](/cli/overview/)
- [Select multiple session daemons](/cli/selectors/)
- [Operate session daemons](/cli/session-daemon-operations/)
- [Session daemon lifecycle](/concepts/session-daemon-lifecycle/)
- [Prompting the agent](/sessions/prompting/)
- [CLI commands and flags](/reference/cli/)
