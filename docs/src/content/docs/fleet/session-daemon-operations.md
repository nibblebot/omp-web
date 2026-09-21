---
title: Start, stop, wake, and remove session daemons
description: "Operate the session daemon behind a roster row: start or wake it, stop or remove it, and understand idle exit and bounded crash restarts."
---

Every roster row represents one session daemon: one `omp-session` process bound to one project or worktree directory. This page covers the row operations that start, stop, wake, and remove that process, plus what the fleet does on its own when a session daemon goes idle or crashes. See [The fleet sidebar](/fleet/sidebar/) for the row layout and [Understand roster status](/fleet/roster-status/) for the status and activity indicators.

Every operation here goes through the fleet, which owns the roster and the spawned processes. A session daemon run by hand outside the fleet has no row; stop it by stopping that process.

Clone workspace rows carry the same operations under provider-managed names, because a clone's compute is created and destroyed by the workspace lifecycle rather than by a spawn template or the supervisor. The names are **Start workspace**, **Stop workspace**, and **Delete workspace…**, and the lifecycle itself is covered in [Clone workspaces](/fleet/clone-workspaces/); the rules below apply to main-checkout, worktree, and remote rows.

## Start a session daemon

- **From a row.** Click the card of an asleep row. The fleet starts a local session daemon and attaches the browser, resuming the row's last session file when it has one and starting a fresh session otherwise.
- **From a project group.** When a project has no main-checkout row, the group header shows a start button labeled **Start a session in &lt;project&gt;**. It spawns a session daemon on the project's main checkout.
- **During onboarding.** **Start a session now** in the **Add repo** dialog or the **Add workspace** modal registers first and then starts: a managed worktree spawns a session daemon, and a clone workspace runs the workspace lifecycle. After the browser attaches, the transcript picker may open; see [Resume previous sessions](/fleet/resume-sessions/).
- **From the CLI.** `omp-web spawn <path> [--template t] [--name n] [--label k=v]...` spawns a session daemon on any directory and prints its new daemon id. A path inside a registered project is tagged with that project; an unregistered path still gets a row, grouped with the other unregistered entries. Full flags are in the [CLI reference](/reference/cli/).
- **An asleep clone workspace.** Click the card, or use **Start workspace** in the row's menu; from the CLI, `omp-web start <selector>` ensures a clone workspace is running. The fleet runs the workspace lifecycle instead of a spawn template: it ensures the provider compute, starts the runtime, and resumes the last session, materializing cold transcripts from the fleet store first. See [Clone workspaces](/fleet/clone-workspaces/).

A start is not finished when the process starts. The row moves through **spawning**, **connecting**, **session**, and **resolving provider/model**, and only becomes **ready** when the session daemon reports that its provider, model, and authentication resolved. The composer stays gated until then; wait for ready instead of resending a prompt. [Session daemon lifecycle](/concepts/session-daemon-lifecycle/) explains each state; [Understand roster status](/fleet/roster-status/) shows what each looks like in the roster.

If the project's configured model or provider is missing, the row can sit in resolving and never become ready. Fix the agent configuration first, then restart the row; see [Start your first session](/getting-started/start-first-session/) and [Troubleshooting](/operations/troubleshooting/).

## Wake an asleep session daemon

Asleep means there is no live process, but the row, its working directory, and its last session file are preserved. Waking produces a live session daemon again in the same directory.

- **Card click on an asleep row** wakes the session daemon with its last session file and attaches this browser. A wake never opens the transcript picker; it resumes silently.
- **Session title line** opens the row's last-ten-sessions dropdown. Picking a different transcript wakes the session daemon with that file instead. Selecting the file that is already current is a plain wake. See [Resume previous sessions](/fleet/resume-sessions/).
- **Remote session daemons are redialed, not respawned.** A remote row has no local child process, so waking it opens a fresh connection to the registered endpoint.
- **A ready row whose control connection was dropped** is also recovered by redialing. The fleet keeps a control connection to ready session daemons, so a healthy process is not replaced.
- **A clone workspace** wakes through the workspace lifecycle rather than a respawn: the fleet re-provisions the clone's compute, resumes the last session, and materializes the transcript from the fleet store first when the volume is cold or missing it. The fleet reconciles clone rows against their desired state on boot, so a clone you left running comes back running.

Wakes are serialized per row. Sending a wake and an attach back to back, which is what a row click does, cannot spawn two processes; the second request waits for the first.

## Stop a session daemon

In the row's actions menu, choose **Stop daemon**, then **Confirm stop**. The first click arms the item and keeps the menu open, so a stray click cannot stop a process. Stop is hidden on asleep rows because there is no live process to stop.

Stopping a local session daemon:

- cancels any scheduled restart,
- closes the fleet's control connection to the process,
- sends `SIGTERM`, waits five seconds, then sends `SIGKILL`,
- marks the row **asleep**.

The roster entry is kept: its working directory and last session file are still there, so you can wake it later. The conversation is untouched because transcripts live on disk, not in the process. If the stopped session daemon was the one this browser was attached to, the chat column is replaced by the **No active session** pane; the row remains in the sidebar.

A remote row stops differently: the fleet closes its connection and marks the row asleep. There is no process to signal, and waking dials the endpoint again.

A clone workspace row stops through the lifecycle instead: **Stop workspace** then **Confirm stop** closes the browser channels and stops the provider compute with proof, keeping the checkout and the session logs, and marks the row asleep. The menu also carries **Stop current work** on the attached clone, which only interrupts the running turn and leaves the workspace running.

From the CLI, `omp-web stop <selector>` performs the same stop. The selector accepts a session daemon id such as `d3`, `all`, a name glob, a `label:k=v` match, or a `project:name` match; see the [CLI reference](/reference/cli/) for the full selector syntax.

## Idle auto-exit

Session daemons are disposable. A session daemon exits on its own once it has been continuously idle, which is normal and does not lose anything.

- The default idle timeout is 30 minutes. It comes from the session daemon's own `--idle-timeout` option, with `OMP_SESSION_IDLE_TIMEOUT` as the environment override; `0` disables it. The default spawn template passes no idle flag, so the 30 minute default applies.
- Idle means nothing is attached, no turn is running, the prompt queue is empty, no dialog is open, and no shell or Python tool call is in flight. Any of those resets the activity clock, and an attached browser suppresses the exit entirely while it stays attached.
- While at least one browser has the fleet open, the fleet keeps ready session daemons dialed, which keeps them attached. The fleet drops its own connection about a minute after the last browser disconnects, and the session daemon's timeout then runs its course.
- On exit, the session daemon logs `omp-session: idle for <ms>ms; shutting down`. The fleet marks the row asleep and keeps the working directory and last session file, so the next wake resumes where the session left off.

You do not have to wait for the timeout to save resources. **Stop daemon** is the explicit way to put a row to sleep immediately.

Clone workspace rows are outside the idle path. Their compute is provider-managed rather than a fleet child process, so the supervisor's idle timer and restart budget do not apply; the fleet reconciles a clone's desired state on boot, and **Stop workspace** is how you shut one down.

## When a session daemon crashes

The fleet restarts an unexpected exit instead of dropping the row.

- A restart is bounded: up to five restarts per crash loop, with jittered exponential backoff between about 1 and 30 seconds. Each restart resumes the row's last session file when it has one, and starts fresh when it does not. Every launch uses a fresh access token.
- Reaching **ready** resets the restart counter, so the budget bounds repeated crashes, not the lifetime of a long-running session daemon.
- When the budget is exhausted the row becomes **error** with a reason such as `child exited 6 times (5 restarts allowed)`. The reason and the captured standard error output are in **Daemon details**; the log view notes that an errored row's tail comes from its last run.

Other terminal errors include a spawn that never reports its listening endpoint, an endpoint that is not a valid URL, a session daemon that rejects the token, and a protocol or working-directory mismatch between the browser, the fleet, and the session daemon. Each surfaces as **error** on the row with the reason in **Daemon details**. To retry an errored local row, stop it and wake it again, which starts a fresh process with a fresh token and resumes its last session file.

## Remove a session daemon

**Remove daemon** in the row's actions menu, then **Confirm remove**, stops the session daemon and evicts it from the fleet roster. The menu item's tooltip says it removes the session daemon from the roster after stopping it, and it is available on asleep and error rows too, where it is the way to clean up a row without a live process.

- The row disappears from the sidebar. The transcript stays on disk and remains resumable from any other session daemon on the same checkout.
- The checkout is not touched. Removing a session daemon is not worktree deletion; use [Safely delete managed worktrees](/fleet/delete-worktrees/) for that.
- A removed main-checkout row can be started again from the project group's start action. A removed worktree row can be adopted again from **Add existing**.
- Removing the row that blocks project removal lets you deregister the project afterward; see [Register and remove projects](/fleet/projects/).
- From the CLI, `omp-web remove <selector>` removes one or more matching session daemons.

Clone workspace rows have no **Remove daemon** item. Their destructive action is **Delete workspace…**, which runs the verified-deletion gate, so a clone can never be evicted from the roster without it. Stopping and deleting a clone are separate acts, and the gate refuses while a turn is running. See [Clone workspaces](/fleet/clone-workspaces/).

There is no way to wake a removed row, because the row itself is gone. Recreate it from the project group's start action, from **Add existing** for a worktree, or by spawning the path again.

## After a fleet restart

Restarting omp-fleet does not lose roster data, but it does lose every child process and connection.

- Persisted rows that were spawned and non-terminal come back **asleep**, because their processes died with the old fleet. Wake them to respawn with `--resume`.
- Remote rows come back **connecting**, and the fleet dials them immediately.
- Rows that were already **asleep** stay asleep, and rows in **error** keep their error so the failure is not masked.
- Clone workspace rows are reconciled against their desired state instead: one you left running is reattached if the provider says it is running, or ensured again if it is not, and one you stopped is left alone.
- The startup banner reports how many sessions were restored and in which statuses, for example `fleet restored N sessions (status: n, ...)`.

## CLI-only operations

- `omp-web start <selector>` is the CLI wake verb, and it is clone-only: it ensures a clone workspace is running. The server refuses non-clone entries, which use `spawn` instead.
- Apart from that, the CLI has no dedicated wake or resume command. `omp-web prompt <selector> <text>` wakes asleep targets on demand before prompting: a spawned row is respawned with `--resume`, and a remote row is redialed.
- `omp-web sessions` lists the roster from the terminal, including each row's status and working directory, which is useful when the browser is closed.
- A session daemon can also be run by hand instead of spawned by the fleet, for a remote host or a one-off process; see [Run a session daemon](/cli/session-daemon/).

## Related

- [Projects, worktrees, session daemons, and sessions](/concepts/projects-worktrees-session-daemons-sessions/)
- [Session daemon lifecycle](/concepts/session-daemon-lifecycle/)
- [The fleet sidebar](/fleet/sidebar/)
- [Understand roster status](/fleet/roster-status/)
- [Resume previous sessions](/fleet/resume-sessions/)
- [Clone workspaces](/fleet/clone-workspaces/)
- [Process lifecycle and recovery](/operations/lifecycle-and-recovery/)
