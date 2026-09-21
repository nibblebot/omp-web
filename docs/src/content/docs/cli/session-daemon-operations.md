---
title: Operate session daemons
description: "List the roster, start local and remote session daemons, stop them, and remove them, and know what each operation does to persisted sessions."
---

A roster row is one session daemon: a local process the fleet started, or a remote session daemon the fleet dials. These commands create rows, stop their processes, and remove them again. The sessions themselves are durable files, so stopping or removing a session daemon never loses a conversation. See [Projects, worktrees, session daemons, and sessions](/concepts/projects-worktrees-session-daemons-sessions/) for the model and [Session daemon lifecycle](/concepts/session-daemon-lifecycle/) for the states a row moves through.

All of these verbs require a running fleet on the control port; see [CLI overview](/cli/overview/).

## List the roster

```sh
omp-web sessions
```

| Column | Meaning |
| --- | --- |
| `id` | The session daemon id used by selectors and by `rm-worktree`, for example `d3` |
| `name` | The display name, which defaults to the checkout directory name |
| `mode` | `spawned` for a row the fleet drives through its own lifecycle, including a clone workspace, and `remote` for a session daemon you registered with `omp-web add` |
| `status` | The current lifecycle status, including `asleep` rows with no live process |
| `project` | The entry's project label, which defaults to the checkout directory basename |
| `cwd` | The bound directory, empty for a remote entry added without `--cwd`; for a clone workspace this is its volume root |
| `labels` | Comma-joined labels, empty when the entry has none |

The command lists every registry entry, so asleep and error rows appear alongside ready ones. It takes no selector. To act on a subset, use the id or filter the table in your shell and pass the result to another command; see [Select multiple session daemons](/cli/selectors/). The table has no column for a clone workspace's lifecycle stage; the browser roster shows that stage while the provider is bringing the workspace up. See [Understand roster status](/fleet/roster-status/).

## Start a local session daemon

```sh
omp-web spawn ~/code/app
omp-web spawn ~/code/app --name app-review --label role=review --label tier=2
omp-web spawn ~/code/app --template review
```

- The path must be an existing directory. The fleet binds it for the process lifetime; there is no way to repoint a running session daemon afterwards.
- The entry name defaults to the directory basename. `--name` overrides it, and `--label k=v` may repeat to attach any number of labels.
- `--template <name>` selects a spawn template from the fleet configuration. An unknown template name fails the spawn instead of falling back to a default.
- When the path belongs to a registered project, whether the main checkout or a linked worktree, the new row is grouped under that project in the browser roster. An unregistered path stays in the ungrouped set. See [The fleet sidebar](/fleet/sidebar/).
- The command returns as soon as the process is launched and reports the new id, name, and status. The row then advances through the transitional statuses to `ready` on its own, so a script that needs readiness should poll `omp-web sessions`.

A local session daemon whose process exits cleanly after its idle timeout becomes `asleep` rather than being restarted, and a crash is restarted a bounded number of times before the row settles in `error`. Both cases keep the last session file, so the row can be woken again. See [Process lifecycle and recovery](/operations/lifecycle-and-recovery/) and [Configure spawn templates](/configuration/spawn-templates/).

## Register a remote session daemon

```sh
omp-web add review-box ws://review-box.example.com:4721 --token "$TOKEN" --cwd /srv/app
```

- The fleet records the entry as `remote` and connects out to the given URL. The remote environment never connects back to the fleet; the fleet is always the dialing side. See [Local and remote sessions](/concepts/local-and-remote/).
- Endpoint URLs are `ws://` or `wss://` shaped, which is the fleet's dial contract; another scheme is rejected. A session daemon that sits behind a port forward should be started with a matching `--advertise` value, or wrapped so its contract line names the reachable address. See [Run a remote session daemon over SSH](/advanced/ssh/).
- `--token <t>` supplies the bearer credential the fleet presents. A session daemon that binds a non-loopback address requires a token, so pass the same value the remote session daemon was started with.
- `--cwd <dir>` records the checkout path for display and grouping context. It does not make the fleet manage or probe that directory, and remote rows are not stamped with a registered project id, so they appear in the ungrouped set of the sidebar.
- `--label k=v` may repeat, exactly as with `spawn`.

A worked SSH setup is covered in [Run a remote session daemon over SSH](/advanced/ssh/).

## Start a session daemon through a hook

```sh
omp-web provision review-box --label role=review
```

`provision` starts a session daemon by running the fleet's configured spawn hook instead of the local template. This is how a provider that allocates a machine on demand plugs into the same registry.

- The hook comes from the `spawnHook` configuration key or the `OMP_FLEET_SPAWN_HOOK` environment variable, and the fleet runs it through `sh -c` with `OMP_HOOK_NAME` and `OMP_HOOK_LABELS` set. The hook has 60 seconds to finish.
- The last non-empty line of the hook's standard output must be JSON with `url` and `token`, and may include `name` and `cwd`. Those fields become the registry entry, which the fleet then dials like any other remote session daemon.
- Failures exit 1: no hook configured, a nonzero hook exit, a timeout, unparseable output, or missing `url` or `token`.

## Wake a stopped clone workspace

```sh
omp-web start d7
omp-web start sandbox-1
```

`start` is the fleet-side ensure-running call for a clone workspace, and it is the terminal equivalent of clicking a parked clone row. The selector matches a session daemon id or an exact roster name, resolved against the roster in this process, and it must identify exactly one row:

- Nothing matches: exit 1 with `no session matches selector: <selector>`.
- The value matches several distinct rows: exit 1 with `selector <selector> matches multiple daemons; use a daemon id`.
- The row is not a clone workspace: exit 1 with `daemon <daemonId> is not a clone workspace (kind <kind>); start a worktree/direct session through /ctl/spawn`. Use `omp-web spawn` for worktrees and direct sessions.

On success the fleet re-provisions the workspace's compute through its provider and resumes the last session; if the volume is cold or the transcript is missing there, the stored lineage is materialized onto the volume before the resume path runs. The command prints `started <daemonId>, observed <observed>`, with the provider's process id appended when it reports one. It returns once the provider reports the workspace running, which is before the daemon has finished resolving its session, so poll `omp-web sessions` if you need the status to settle at `ready`.

`stop` and `remove` do not need `start`: `stop` parks a clone by stopping its compute and keeping the volume, and waking it later is what `start` does. See [Clone workspaces](/fleet/clone-workspaces/).

## Stop a session daemon

```sh
omp-web stop d3
omp-web stop project:app
```

`stop` accepts any selector and stops every match; see [Select multiple session daemons](/cli/selectors/).

- A `spawned` row is terminated gracefully first, with a forced kill five seconds later if it does not exit, and its status becomes `asleep` with the last session file preserved.
- A `remote` row is disconnected and marked `asleep`.
- A clone workspace stops its provider-managed compute and keeps its volume, so the checkout and the session logs stay exactly where they were.
- The row stays in the roster in all three cases. The bound directory is untouched.
- A selector that matches nothing exits 1 and stops nothing.

An asleep row is woken on demand: by a fan-out prompt that targets it, by attaching to it from the browser, or, for a clone workspace, with `omp-web start`. Waking a local row respawns the process and resumes its last session; waking a remote row redials it; waking a clone re-provisions compute and materializes any missing transcript from the log store first. See [Fan-out prompting](/cli/fanout/) and [Start, stop, wake, and remove session daemons](/fleet/session-daemon-operations/).

## Remove a session daemon

```sh
omp-web remove d3
omp-web remove label:role=review
```

`remove` accepts the same selectors as `stop`, but it deletes the roster row instead of leaving it asleep:

- A `spawned` row is stopped first, then its fleet-side process state is dropped.
- A `remote` row is disconnected and dropped.
- The registry entry disappears, and with it the row in the browser.
- The checkout, the Git state, and the session transcripts are untouched. Transcripts are not stored inside the checkout, so removing or deleting a worktree cannot remove them.
- A clone workspace is the exception: `remove` routes through the same verify-at-deletion gate as `rm-worktree`, because a kind-blind roster eviction must not be able to bypass it. The workspace, its volume, and its stored logs are deleted together, and a blocked gate leaves all three in place with a typed error instead.

For a managed worktree, removing the roster row alone leaves the directory in place. Use `omp-web rm-worktree <daemon-id>` to stop, evict, and delete the directory in one guarded operation, which is also the single-target form of clone deletion; see [Manage projects and worktrees](/cli/projects-and-worktrees/).

## Failure behavior

| Situation | Result |
| --- | --- |
| Path does not exist or is not a directory | Exit 1 with the validation message; no entry is created |
| Unknown spawn template | Exit 1; the spawn fails instead of falling back |
| Endpoint URL rejected | Exit 1 when adding a remote entry |
| No spawn hook configured | Exit 1 for `provision` |
| Hook failure, timeout, or bad JSON | Exit 1 with the hook error |
| Selector matches nothing | Exit 1 with a message naming the selector; nothing is stopped or removed |
| `start` on a row that is not a clone workspace | Exit 1 with the refusal naming the row's kind; use `omp-web spawn` instead |
| Clone deletion refused by the verification gate | Exit 1 with the reason; the workspace, volume, and logs are retained |
| Fleet not running | Exit 1 with the not-running message |

## Related

- [CLI overview](/cli/overview/)
- [Manage projects and worktrees](/cli/projects-and-worktrees/)
- [Select multiple session daemons](/cli/selectors/)
- [Fan-out prompting](/cli/fanout/)
- [Session daemon lifecycle](/concepts/session-daemon-lifecycle/)
- [Start, stop, wake, and remove session daemons](/fleet/session-daemon-operations/)
- [Clone workspaces](/fleet/clone-workspaces/)
- [Stored sessions](/analysis/stored-sessions/)
- [CLI commands and flags](/reference/cli/)
