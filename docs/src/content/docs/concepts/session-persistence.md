---
title: Session persistence
description: "What survives a restart in omp-web: durable session transcripts and fleet state on disk, disposable session daemons, and browser preferences that never leave the browser."
---

omp-web splits its data into two kinds. Durable data is written to disk and outlives every process that touches it. Everything else belongs to a running process or a browser tab and disappears with it. Almost every recovery behavior follows from that split: a session daemon can die, sleep, or be replaced at any moment, and the conversation it was serving survives.

## What is durable

| Data | Where it lives | Written by | Notes |
| --- | --- | --- | --- |
| Session transcript | The `sessions` subtree of the agent directory (`~/.omp/agent/sessions` by default; `$PI_CODING_AGENT_DIR/sessions` or `$XDG_DATA_HOME/omp/agent/sessions` when those are set) | the agent SDK inside the session daemon | One JSONL file per session. Subagent transcripts are written into a directory named after the session file. |
| Session name and title | inside the session transcript | the session daemon | The fleet reads the title back out of the JSONL for the roster row. |
| Fleet state | `fleet-state.json`, next to the fleet config file by default | the fleet | Roster entries (bind directory, last session file, probed title and git facts, endpoint, the token used to dial it), registered projects, and the id counters. Every mutation is written atomically (temporary file, then rename) before it returns. |
| Fleet config | `config.json` in the data home | the first-run offer is the only writer | Holds the workspace directory the offer recorded. You can add templates, a default template, per-project templates, and a spawn hook by editing the file yourself. |
| Statistics database | `~/.omp/stats.db` (or `$PI_CONFIG_DIR/stats.db`) | the statistics sync action | A derived index over transcripts. Deleting it or leaving it stale costs you analytics, never conversations. |
| Browser preferences | `localStorage` in your browser | the browser UI | Theme, font size, sidebar and group visibility, the Work or Analysis view, notifications, the sidebar usage widget, and prompt history. Per browser and per profile. |

The agent directory is the same one the `omp` CLI uses. The fleet never copies it, and session transcripts never live inside a worktree, which is what makes worktree cleanup safe.

## What is not durable

Everything a session daemon holds in memory goes away with the process:

- The turn currently streaming and any queued follow-ups.
- Open extension dialogs waiting for your answer.
- In-flight bash and eval commands.
- The attachment between a browser tab and a session daemon, and the live context and cost meters that are rebuilt when a tab attaches.
- Fleet-side liveness facts such as the process id and uptime, which the roster clears as soon as a row goes asleep.

None of this is lost work in the durable sense. Reattaching or waking the row rebuilds it: the transcript is reloaded, the live state is re-announced, and you continue from the last completed turn. Mid-turn work that was interrupted by a process death is the one thing that does not come back, which is why the retry action exists; see [Compaction, retry, and recovery](/sessions/recovery/).

## One transcript, one writer at a time

A session file is locked for the lifetime of the session daemon that owns it. The lock is a pidfile next to the transcript, and it is self-healing: a lock left behind by a process that no longer runs is broken automatically. A second live session daemon aimed at the same transcript refuses to start and prints the holder instead of racing it:

```text
omp-session: session file /home/you/.omp/agent/sessions/app/1712.jsonl is locked by another omp-session (pid 40221)
```

This is why you can start `omp-web session --resume <file>` on a transcript that the fleet already supervises and get a clear refusal rather than two processes overwriting one history. It is also why the fleet wakes a row instead of starting a second process next to it: waking is serialized per session daemon, and a resume that is already in flight is not launched twice.

## Resuming

Waking or attaching to a row does one of two things:

- **It resumes the row's last session file.** The local session daemon is started with the resume file, or the remote one is dialed again. The fleet records the last file it saw from the session daemon, so this works even after the process that wrote it is long gone.
- **It starts a fresh session when the row has none.** A row for a checkout that has never run, or a project's default workspace, has no session file yet, so the first start creates one.

The per-row session dropdown lists the last ten sessions for that checkout, newest first, read from disk. Selecting an entry resumes that exact file instead of the last one. Listing and resume are scoped to the directory the session daemon is bound to, so a checkout never offers another project's sessions.

Two failure cases are worth knowing:

- If the file behind a row's last session was removed outside omp-web, a resume of that file fails and the session daemon logs that it is starting fresh. The row is not broken; it has no history to restore.
- If a resume would open a transcript in use by another live process, the start is refused with the lock message above. Waking the existing row is the safe path.

## What survives what

| Event | Session transcript | Fleet registry | Browser preferences |
| --- | --- | --- | --- |
| Browser reload or tab closed | unchanged | unchanged | unchanged |
| Session daemon exits after its idle timeout | unchanged | row marked asleep | unchanged |
| Session daemon crash | unchanged | bounded restart, row returns to ready | unchanged |
| You stop a row in the UI | unchanged | row marked asleep | unchanged |
| Fleet restart | unchanged | reloaded from `fleet-state.json`; spawned rows come back asleep and remote rows are redialed | unchanged |
| `omp-web update` | unchanged | unchanged | unchanged |
| Managed worktree deleted in the UI | unchanged, transcripts live outside the checkout | the worktree row is removed | unchanged |
| Project deregistered | unchanged | the registration is dropped; repository files are untouched | unchanged |

Two consequences are easy to miss. First, stopping or removing a row never deletes a conversation: removal touches the roster, not the session files. Second, deleting a managed worktree removes a checkout, not the sessions recorded in it, so a transcript can outlive the directory it was created in and still be read from Analysis.

## Fleet state and the data home

Fleet state is small, but it is the file the fleet cannot lose. It holds the roster, the registered projects, and the bearer token used to dial each session daemon. It is written next to the config file, so the data home chosen at first run moves configuration, state, and managed worktrees together.

- The state file is protected by an exclusive lock for the lifetime of the owning fleet. A second fleet against the same state refuses to start instead of clobbering it.
- Writes are atomic, so an interrupted fleet cannot leave a half-written roster.
- The state file contains tokens and should be treated as private. Tokens are never sent to the browser: roster frames carry session daemon ids, statuses, and metadata, never credentials or endpoints.
- A corrupt state file is reported with its path at startup. Because the roster is metadata rather than history, rebuilding it by registering projects again costs you rows, not conversations.

## Related

- [Projects, worktrees, session daemons, and sessions](/concepts/projects-worktrees-session-daemons-sessions/) for the objects this page tracks across restarts.
- [Session daemon lifecycle](/concepts/session-daemon-lifecycle/) for the states that trigger each recovery path.
- [Manage session history](/sessions/history/) for the actions that create, copy, or replace transcripts.
- [Export and download sessions](/sessions/export/) for getting a transcript out of the data home.
- [The fleet sidebar](/fleet/sidebar/) for reading sleep, reconnection, and error rows.
- [Reference](/reference/) for the canonical lists of file locations, environment variables, and configuration keys.
- [Troubleshooting](/operations/troubleshooting/) for lock, state, and stale-statistics failures.
