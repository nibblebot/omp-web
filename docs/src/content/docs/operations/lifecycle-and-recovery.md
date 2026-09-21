---
title: Process lifecycle and recovery
description: Operator guide to process ownership, stop, sleep, and wake behavior, bounded crash restarts, fleet restart reconciliation, browser reconnect, locks, durable state, and the safe recovery order.
---

This page is the operator view of omp-web process lifecycle: who owns each process, what a normal stop or sleep does, how crashes are contained, what survives a restart, and in which order to recover a broken fleet. For the state model a user sees in a roster row, see [Session daemon lifecycle](/concepts/session-daemon-lifecycle/). For the row actions themselves, see [Start, stop, wake, and remove session daemons](/fleet/session-daemon-operations/).

The two rules behind everything here:

- Session daemons are disposable. A session is a durable transcript on disk, so stopping, losing, or restarting the process never loses a conversation. For a managed clone workspace the same transcript is also mirrored into the fleet log store, so wake can restore it even when the volume no longer has it.
- Remote connectivity is dial-in, with one exception. The fleet connects out to a session daemon's endpoint, and a direct or worktree session daemon never connects back to the fleet. A managed clone workspace's daemon has no inbound service at all: it dials the fleet's callback pair outbound, so the fleet supervises its connection rather than a local child process.

## Process ownership

| Process | Started by | Owns | Ends on |
| --- | --- | --- | --- |
| Fleet (`omp-web`, `omp-web serve`) | You, in a terminal | The loopback control plane, the browser edge, the roster state file and its lock, the spawned session daemon children, and the connector sockets | `Ctrl+C` or `SIGTERM` (exit 0), or a crash |
| Session daemon (`omp-session`, launched as `omp-web session`) | The fleet through a spawn template, or you manually for remote hosts | One bound working directory, one live session, its session file lock, and its idle timer | An idle auto-exit, an explicit stop, a crash, or shutdown of its supervising fleet |
| Remote session daemon | Whatever runs on the remote host (a shell, an SSH session, a container entrypoint) | The same state on that host | Outside the fleet's control |
| Clone workspace daemon | The clone lifecycle service, through a provider (bwrap or Kubernetes) | One provider volume: the `.checkout/` clone, a private home with the transcripts under `.home/agent/sessions`, and the outbound callback pair | An explicit stop, deletion through the verified gate, or a provider-side failure. The lifecycle owner never stops clone compute on its own |
| Browser tab | You | No process. It holds one SSE stream to the fleet, and its actions are requests to the fleet | Tab close or navigation |

Ownership has three practical consequences:

- Exactly one fleet process may write a given roster state file, and exactly one session daemon may own a given transcript at a time. Both rules are enforced by pidfile locks, described under [Locks](#locks).
- Row actions are requests to the fleet, not direct signals. The browser never signals a process itself; the fleet owns the processes it spawned, and a session daemon run outside the fleet has no row to act on.
- A forced end of the fleet (a `SIGKILL`, a host crash, or any abrupt process death) skips orderly shutdown, so locally spawned session daemons can outlive it. Prefer `Ctrl+C` or `omp-web stop <selector>`; see [Recover after a force-killed fleet](#recover-after-a-force-killed-fleet).

## Normal stop, sleep, and wake

### Clean fleet shutdown

Stop the fleet with `Ctrl+C` in its terminal, or send it `SIGTERM`. The fleet closes the browser edge and the connector sockets, stops every spawned session daemon with the same `SIGTERM` and forced-kill escalation used by `omp-web stop`, sets those rows to `asleep`, closes its statistics handle, and releases the state lock last. The command exits 0.

Expected result: every spawned row is persisted as `asleep` with its working directory and last session file intact, remote rows are untouched on their hosts, and nothing else writes the state file afterward. Wake the rows you need when you start the fleet again. Remote rows redial themselves; see [Fleet restart and reconciliation](#fleet-restart-and-reconciliation).

### Stop one session daemon

`omp-web stop <selector>` (browser: the row's **Stop daemon** item) stops every matching row:

- A local spawned row is signalled with `SIGTERM`, escalated to `SIGKILL` after five seconds, and marked `asleep`. Its last session file and working directory are kept, and the next spawn mints a fresh access token.
- A remote row is disconnected and marked `asleep`. Nothing is signalled on the remote host, and its process keeps running there.
- A clone workspace takes a third path, the provider-owned stop described under [Stop, wake, and delete a clone workspace](#stop-wake-and-delete-a-clone-workspace).

Stopping a session daemon never deletes a transcript: session files live outside the worktree, under the agent directory. If you want the conversation gone, that is a transcript-management action, not a lifecycle action. To stop a session daemon and also drop its roster entry, use `omp-web remove <selector>`; removal runs the same stop first, then discards the entry and the supervisor state behind it. Removing a managed-worktree row leaves the directory on disk; [Safely delete managed worktrees](/fleet/delete-worktrees/) is the deletion path.

### Sleep by idle auto-exit

A session daemon whose process is not needed exits on its own. This is the intended steady state, not a failure.

- The default idle timeout is 30 minutes, configurable on a directly started session daemon with `--idle-timeout <duration>` or `OMP_SESSION_IDLE_TIMEOUT`; `0` disables the timer. The default spawn template relies on the 30 minute default.
- Idle means no attached client streams, no running agent turn, an empty prompt queue, no open dialog, no in-flight shell or Python tool call, and no live collaboration room. Any activity resets the clock.
- The session daemon checks the clock every 15 seconds by default and logs `omp-session: idle for <ms>ms; shutting down` before exiting cleanly. The supervisor recognizes a clean exit after a `ready` status with its control socket already dropped and marks the row `asleep`, keeping the working directory and last session file.

While a browser has the fleet open, the fleet keeps a control connection to every `ready` session daemon so activity indicators stay live. That connection counts as an attached client, so idle exit is suspended for those session daemons until the last browser disconnects. The fleet then drops its own socket after about 60 seconds, and the session daemon's 30 minute timer runs from there. A `ready` row going `asleep` while a browser tab is open usually means something ended the process: a stop, a crash, or a supervisor error.

### Wake and resume

Clicking or waking an `asleep` row is a supervisor action:

- A local spawned row is respawned with `--resume <last session file>` and a fresh per-spawn token.
- A remote row is redialed at its registered endpoint.
- A `ready` row whose control socket was merely idle-dropped is redialed, not replaced, because the live process is still healthy.

A wake does not open the transcript picker; [Resume previous sessions](/fleet/resume-sessions/) covers picking a different session from the row's dropdown. When a wake is attached to a browser, the browser waits up to 60 seconds for the session daemon to report `ready`. The wait fails with an error frame on the row if readiness never arrives, typically because a provider or model is missing. From the CLI, `omp-web prompt <selector> <text>` also wakes `asleep` targets before prompting; see [Operate session daemons](/cli/session-daemon-operations/).

### Stop, wake, and delete a clone workspace

A managed clone workspace rides the same roster as a worktree session daemon, but its lifecycle belongs to the clone lifecycle service (`fleet/workspace-lifecycle.ts`) rather than the worktree guards. The roster surfaces its stage as `preparation`, `runtime`, `callback`, or `ready`, with `failed` carrying the lifecycle error text. See [Clone workspaces](/fleet/clone-workspaces/).

- **Stop keeps the workspace.** `omp-web stop <selector>` on a clone runs the proof-bearing provider stop (a stop that cannot prove termination is refused with `stop of <daemonId> could not prove termination (observed running)`), then persists `desiredState: stopped`, marks the row `asleep`, and revokes the callback enrollment for that generation. The volume is untouched, so the checkout and every session log written under `.home/agent/sessions` survive.
- **Wake re-provisions compute and resumes.** Waking the row, or `omp-web start <daemon-id>`, reconciles through the lifecycle owner: it inspects the provider for a surviving predecessor, provisions or reattaches compute, re-establishes the callback pair, and resumes the last session. When the resume target's transcript is cold or missing on the volume, the daemon requests it over the bulk channel and the fleet serves the validated stored lineage into `.home/agent/sessions` before the existing `--resume` path runs; the materialized tree is byte-identical, verified by size and sha256 before the file is renamed into place. An explicit resume target that exists nowhere fails typed `unavailable` instead of silently booting a fresh session. Before a wake resume the fleet unlinks the stale `<session>.lock` beside the target, because bwrap pid namespaces confuse the daemon's liveness probe; the stop proof above is what makes that safe.
- **Deletion is a separate, verified gate, not the worktree guards.** Removing a clone, or deleting it from the UI, runs the verify-at-deletion gate: admission (refused while a live workspace's activity cannot be observed), quiesce with a proven stop, the clone's Git guard over `.checkout` (uncommitted or untracked files, stashes, and commits not preserved on the remote all block), fleet-store verification cross-checked against the volume's own session tree, a read-only flip, then provider deletion, volume deletion, and roster removal. The worktree guards never apply here: they reason about a fleet-local directory that a clone volume does not have. There is no force override, a blocked deletion keeps the workspace, its volume, and its logs, and the entry carries `delete-pending-retry` plus the gate's message. A blocked deletion is not an orphan: it keeps the live entry, volume, and store in place. A store subtree becomes an orphan only when its workspace disappeared without a passed gate (deleted outside the fleet, for example); those are listed by `GET /ctl/logs/orphans`, and only an explicit `POST /ctl/logs/purge {workspaceId}` removes one.

Deleting a clone row with `omp-web remove <selector>` routes through the same gate, so nothing evicts a clone around verification.

## Bounded crash restart

An unexpected session daemon exit is restarted automatically instead of leaving the row dead.

- Each attempt launches a fresh process with a fresh access token, resuming the row's last session file when it has one.
- Retries are jittered exponential backoff from about 1 second up to about 30 seconds.
- At most five consecutive restarts are allowed. Reaching `ready` resets the counter, so the budget bounds crash loops, not the lifetime of a healthy session daemon. A row that crashes, recovers to `ready`, and crashes again later never exhausts the budget.
- When the budget is exhausted, the row becomes `error` with a reason such as `child exited 6 times (5 restarts allowed)`, and the captured standard error tail is available in Daemon details.

Three categories of exit never enter the restart loop:

- Intentional stops and replacements: `omp-web stop`, a manual wake respawn, and a clean idle exit. Each is flagged so the exit handler does not restart.
- Failures the supervisor has already classified as terminal: `spawn failed: <message>` when the process cannot be launched at all, `endpoint timeout: no OMP_SESSION| listening line within 30s`, and `invalid endpoint from child: <url>`. The row is `error` and no restart loop runs.
- Connector-terminal conditions, where the process may be alive but is not drivable: `unauthorized (401): daemon rejected the token`, `proto mismatch: daemon speaks OMP_PROTO <actual>, expected <expected>`, and `cwd mismatch: omp-session reports <reported>, registered <registered>`.

Operator levers:

- Waking an errored row always gets one fresh launch attempt. If it reaches `ready`, the crash budget resets. If it exits before `ready` with the budget already exhausted, the row returns to `error` immediately.
- Removing the row and starting it again drops the supervisor's per-row state entirely, including the exhausted budget.
- A permission or version fix must happen on the failing side first: a 401 needs the endpoint and stored token to match the session daemon again (a fleet-managed wake mints a fresh token, a manually started or remote session daemon needs its own token fixed), and a protocol mismatch needs compatible releases on both sides, see [Updates](/operations/updates/).

## Fleet restart and reconciliation

The registry persists, but child processes and connector sockets do not. On every fleet start, before the control plane starts acting on the roster, the fleet reconciles each persisted entry to a truthful boot state:

| Persisted state | After restart | Recovery |
| --- | --- | --- |
| `asleep` or `error` | Kept as is | Wake an `asleep` row; fix the cause and wake an `error` row |
| Spawned, any other status | `asleep`, with `pid` and `readyAt` cleared | Wake respawns with `--resume` |
| Remote or attached, any other status | `connecting`, dialed immediately | None needed; the redial runs at boot |
| Clone workspace | Re-inspected through its provider: a running predecessor is reattached at the same generation, a stopped or missing one is ensured when its desired state is `running`, and a stopped-desired workspace is left alone | None for a reattach; the ensure path is the wake path |
| Clone workspace with a persisted `deleting` state | `delete-pending-retry` with the reason recorded | Retry the deletion through the same gate |

Each downgrade is written to the fleet log as `boot reconcile: <old status> → <target>`, and the startup banner reports the restored session counts by status. Spawned rows are deliberately not auto-started: a fleet restart never launches new agent processes by itself, it only marks them wakeable. Clone compute is not an in-memory child, so it survives a restart and is reattached rather than respawned; only the callback pair is rebuilt.

To restart a fleet safely:

1. Stop it cleanly with `Ctrl+C` and wait for the process to exit. Do not `SIGKILL` it if you can avoid it.
2. Start it again with `omp-web` (or `omp-web serve`). If a second fleet is still running against the same state file, the start refuses with exit 77 and `fleet already running (pid <pid>)` plus the lock path; keep using the running fleet or stop it first.
3. Read the restored rows. Expect spawned rows `asleep` and remote rows `connecting`.
4. Wake what you need by clicking rows, or start new ones with `omp-web spawn <path>`.

Nothing about a restart requires touching files. Transcripts, managed worktrees, the config file, and the statistics database are all outside the fleet process.

## Locks

omp-web uses pidfile locks, created atomically and checked against process liveness. Two locks protect the state you cannot afford to interleave:

- Fleet state lock: `<statePath>.lock` next to the state file, taken before the control plane starts and held for the fleet's lifetime. It is released last in shutdown, after every child and socket is torn down. A second fleet against the same state file exits 77 and names the holder.
- Session file locks: `<sessionFile>.lock` next to the transcript. The session daemon takes one for an explicit `--resume` target before the session exists, and one for the live session file once the session is created, so a second session daemon aimed at the same transcript exits 1 with `omp-session: session file <file> is locked by another omp-session (pid <pid>)`. This protects every resume path, including a fleet respawn and a browser-driven session switch.

Lock behavior an operator should rely on:

- A lock left behind by a process that is no longer running is detected and reclaimed automatically on the next start. You never need to clean up a crashed process's lock yourself.
- A lock that is still held means a live process owns that state, and the holder's pid is named in the error. Resolve the conflict by keeping the owner, stopping it, or choosing a different transcript.
- Never delete a lock file to force a start. Deleting a live lock removes exactly the protection that prevents two writers from clobbering one state file or transcript. See [Troubleshooting](/operations/troubleshooting/) for the lock symptoms and [Data and state management](/configuration/data-and-state/) for where the files live.

## Browser reconnect

The browser holds one long-lived SSE stream. Reconnection is automatic in three layers, from cheapest to most explicit:

- A transient blip is handled by the browser's native EventSource reconnect, which replays from the last event id. The session daemon and the fleet edge keep bounded replay rings, so frames produced during a short gap are delivered rather than lost.
- A terminally closed stream is retried by the client at 1 second, 2 seconds, 4 seconds, and up to 8 seconds; the delay resets the moment a stream opens again. No unit of data (frame, keepalive, or comment) for 30 seconds forces an immediate reconnect with no backoff, because a silent but open stream is treated as a dead peer.
- A stream the consumer cannot keep up with is ended in-band by the producer instead of being allowed to stall. The consumer resumes from the last event id; this is a slow reader, not a dead session daemon.

After a reconnect, the browser re-attaches to the session daemon it was viewing. Attaching to an `asleep` row wakes it, so a session daemon that slept while the tab was backgrounded comes back when the page reconnects. Readiness is per connection and the composer stays gated until the new stream reports `ready`. When a browser stream disconnects, the fleet edge keeps its replay ring for about 60 seconds; a browser that returns within that window resumes, and one that returns later re-attaches and re-primes from scratch.

Two conditions are terminal and will not recover by waiting:

- Protocol mismatch, where the browser and the serving process are incompatible builds. The client does not start its retry loop, because retrying cannot fix versions.
- An unauthorized response, such as a 401 from a remote session daemon that rejects the token. A manual reload does not help; fix or re-mint the token first.

The Debug panel exposes the stream state, the pending retry delay, the client transport log, and per-row connector state with the attempt counter and next retry time. See [Debug panel and diagnostics](/operations/diagnostics/) for what to read and [Troubleshooting](/operations/troubleshooting/) for the reconnect symptoms.

## Durable state

Disposability only works because the important state lives outside the processes:

| State | Location | Survives |
| --- | --- | --- |
| Session transcripts | `.jsonl` files under the agent directory, outside worktrees; managed workspaces also mirror them into the fleet log store | Process exit, fleet restart, stop, remove, and managed-worktree deletion; a cold clone volume gets them materialized back before `--resume` |
| Roster and registered projects | Fleet state JSON, written atomically on every mutation | Fleet restarts; a data-home change starts a new, empty roster |
| Clone workspace records | The same fleet state JSON, as the fleet-private `WorkspaceRecord` on clone entries (source, pin, profile, generation, desired state, deletion state) | Fleet restarts; never serialized to roster or debug surfaces |
| Fleet log store | `<state dir>/logs/<workspaceId>/<sessionId>/<relpath>` plus a per-session `index.json` | Fleet restarts; verified history is deleted only through the deletion gate, or explicitly purged |
| Managed worktrees | Under the configured workspace directory | Stop, remove, and fleet restart; deletion is a separate guarded action |
| Clone workspaces | A provider volume holding `.checkout/` and `.home/agent/sessions` | Stop, fleet restart, and provider restarts; deletion is a separate verified gate |
| Fleet configuration | The config file, read at start | Fleet restarts; only the first-run offer writes it |
| Statistics database | `stats.db` under omp's config root, read-only from the fleet | Fleet restarts; it can lag until a sync runs, see [Sync the statistics database](/analysis/stats-sync/) |
| Browser preferences | Browser `localStorage` | Everything except clearing site data. Browser auth puts nothing here: the session lives in the `omp_session` cookie |

No process holds the only copy of a conversation, and no recovery step requires hand-editing state. Exact paths and precedence are owned by [Files and directories](/reference/files/) and [Data and state management](/configuration/data-and-state/); [Session persistence](/concepts/session-persistence/) explains transcript durability in depth.

## Safe recovery order

Work top-down and fix causes before forcing states. Session daemons and fleets are safe to restart, so a wrong guess costs a restart, not data. Prerequisites for the steps below: a terminal on the machine that runs the fleet (or browser access to the roster), and permission to stop the processes involved. Every step is safe to repeat.

1. Identify the failing layer. A roster row status, the Debug panel, and the terminal that runs the fleet point at the same failure from different angles. Give automatic recovery a chance first: idle wakes, backoff redials, and bounded restarts usually resolve transient failures without intervention.
2. Fix the root cause. Provider or model setup, a bad spawn template, a remote host that is unreachable, a token that no longer matches, or incompatible versions. Restarting before fixing only reproduces the failure.
3. Stop what must stop, cleanly. Use `omp-web stop <selector>` for rows and `Ctrl+C` for the fleet. Never delete a lock file, and avoid `SIGKILL` unless the process is truly wedged.
4. Start the fleet if it is down: `omp-web` or `omp-web serve`. Confirm the restored-status lines and expect spawned rows to come back `asleep`.
5. Wake rows on demand by clicking them, or start fresh ones with `omp-web spawn <path>`. A wake resumes the last session file, so the conversation continues where it stopped.
6. Verify at the surface: the row reaches `ready`, the browser re-attaches with a fresh priming of the transcript, and a prompt gets a response.
7. If a start is still refused, read the message. A held lock names its live holder; the failure text names the component to fix.

### Recover a sleeping or errored row

Prerequisite: the fleet is running and the row is visible. A sleep needs no action beyond waking it when you want it. For an `error` row, open Daemon details first and read the failure, fix the cause, then wake it. A wake gets one fresh attempt with a freshly minted token and re-runs endpoint resolution; a provider, template, or version problem reproduces until it is fixed.

### Recover after a fleet crash

A crashed fleet is recovered by starting a new one; the roster is already on disk. Expect one `boot reconcile` line per affected row, spawned rows `asleep`, and remote rows dialed immediately. A lock left by the dead process is reclaimed automatically on the next start because its pid no longer runs, so a crash never requires lock cleanup. Wake the rows you need.

### Recover after a force-killed fleet

If the fleet process was killed in a way that skipped shutdown, local session daemons can still be running as ordinary processes, holding their session file locks and their endpoints while no fleet tracks them.

1. Check what is running: `omp-web sessions` shows the roster the new fleet knows about, and system tools such as `pgrep -af "omp-web session"` show surviving processes.
2. Start a new fleet. It will mark the previously spawned rows `asleep` because their supervising process is gone.
3. Recognize the collision before waking: a wake that respawns a row whose transcript is still held by an orphan fails with the session lock error naming the orphan's pid. That is the lock doing its job.
4. Resolve it by stopping the orphan or by waiting. An unattended orphan exits on its own after its idle timeout (30 minutes by default, measured from its last activity), or you can signal the pid named in the lock error. Then wake the row normally.
5. Never delete `<sessionFile>.lock`. The lock is the reason two processes cannot corrupt one transcript; deleting it while the orphan lives recreates the exact race it prevents.

### Recover a locked transcript

The message `omp-session: session file <file> is locked by another omp-session (pid <pid>)` identifies the owner. Keep one owner per transcript: either stop the session daemon named by the pid, or resume a different session from the row's session dropdown instead of the locked one. Locks from dead processes clear themselves on the next start, so a lock error always means a live holder, not leftover files.

### Recover a session daemon you started yourself

A session daemon run by hand, for example on a remote host the fleet dials in, has no supervisor and no roster row. If the process exits, nothing restarts it, and the fleet keeps redialing its endpoint until it returns.

1. Check the terminal output for the exit cause, including the idle exit line.
2. Restart it in the same working directory: `omp-web session --cwd <dir>`. Add `--resume <file>` to continue a specific transcript. A fleet entry that points at the endpoint reconnects on its own once the session daemon answers again.
3. If the process must stay up unattended, start it with `--idle-timeout 0` or supervise it with your own process manager or its host's container restart policy.
4. The same lock rules apply: a second `omp-web session` on a held transcript refuses to start until the first process exits.

### Move or reset the data home

The data home holds the config file, the roster state file, and managed worktrees. Session transcripts live under the agent directory instead, so they survive a data-home change:

1. Stop the fleet cleanly. Never move state files while a fleet holds the lock.
2. Start the fleet with the new home (see [First run](/getting-started/first-run/) for the selection and [Data and state management](/configuration/data-and-state/) for the paths and overrides).
3. Expect an empty roster, because projects are part of the state file. Re-register the repositories you need.
4. Start a session daemon in a checkout that has transcripts on disk and the session picker offers them, because listing reads the agent directory, not the fleet state. [Resume previous sessions](/fleet/resume-sessions/) covers the picker.
5. Managed worktrees from the old home remain on disk under the old workspace directory and can be adopted as existing worktrees if you need them.

## Common failures

| Symptom | Meaning | First action |
| --- | --- | --- |
| Start refused with exit 77 and `fleet already running (pid <pid>)` | Another live fleet owns the state file lock | Use the running fleet, or stop it cleanly and start again |
| Start refused with `session file <file> is locked by another omp-session (pid <pid>)` | A live session daemon owns that transcript | Stop that session daemon or resume a different session; never delete the lock |
| Row sits in `resolving` and never becomes ready | Provider, model, or authentication resolution did not finish | Fix the omp setup, then stop and wake the row |
| Row is `error` with a restart-budget or endpoint message | Crash loop or a spawn that never reported its endpoint | Read Daemon details, fix the cause, wake once; remove and re-add to clear a stale budget |
| Row is `error` with `unauthorized (401)` | The stored token does not match the session daemon | Wake to re-mint for a fleet-managed session daemon, or fix the token for a manual or remote session daemon |
| Row is `error` with a protocol or cwd mismatch | Incompatible builds, or an entry pointing at the wrong directory | Update both sides, or correct the entry; retrying cannot fix either |
| Browser shows `reconnecting` with a growing delay | The stream closed and the client is on its 1 to 8 second ladder | Wait for automatic recovery, then check that the fleet and the session daemon are still running |
| Browser never reconnects at all | A terminal case such as a protocol mismatch or a rejected token | Fix the version or token, then reload |
| Clone deletion refused with `delete-pending-retry` and a gate message | The verify-at-deletion gate did not pass, and the workspace, volume, and logs were retained | Read the message: Git guard text needs a commit, push, or stash inside the clone; `live with unobservable activity` needs `omp-web stop` first; a store or quiesce message means the transcript mirror or the compute stop could not be proven |
| Clone wake or resume fails typed `unavailable` | The resume target exists neither on the volume nor in the fleet log store, or the workspace was deleted | Pick a session that exists on the volume, or use the explicit resume-onto-fresh-clone action for a deleted workspace; verify the fleet log store is present |
| Clone row is `error` with a `lifecycleError` | A lifecycle stage failed: preparation, runtime, or callback | Read the error text and the fleet log, fix the provider side, then wake the row; `omp-web preflight --profile <id>` checks the profile before a retry |
| Clone row sits on `preparing workspace` or `connecting channel` | A lifecycle stage is still running, or its provider op is retrying | Watch the transitions; a failed stage surfaces its typed error as `lifecycleError` on the roster, and boot-time inspect failures are logged as `clone boot reconcile: inspect failed ...` |

[Troubleshooting](/operations/troubleshooting/) expands each symptom with the exact messages, and its final section lists what to collect from the Debug panel for a bug report.

## Related pages

- [Session daemon lifecycle](/concepts/session-daemon-lifecycle/)
- [Start, stop, wake, and remove session daemons](/fleet/session-daemon-operations/)
- [Clone workspaces](/fleet/clone-workspaces/): create, stop, wake, and verified deletion
- [Session persistence](/concepts/session-persistence/)
- [Understand roster status](/fleet/roster-status/)
- [Operate session daemons](/cli/session-daemon-operations/)
- [Debug panel and diagnostics](/operations/diagnostics/)
- [Troubleshooting](/operations/troubleshooting/)
