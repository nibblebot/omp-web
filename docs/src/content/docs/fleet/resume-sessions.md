---
title: Resume previous sessions
description: "Reopen a durable transcript from a roster row: the last-ten-sessions dropdown, the onboarding New session or resume picker, and what waking with a chosen file does."
---

A session is a durable conversation stored as a JSONL transcript on disk. Session daemons are disposable, so resuming is a normal part of the workflow rather than a recovery step. This page covers the ways the fleet roster reopens a transcript. For the full history toolkit inside a live session, including `/resume`, rename, branch, fork, compact, and drop, see [Manage session history](/sessions/history/).

Resuming from the roster is available in fleet mode, where the browser talks to the fleet. Single-session mode has no roster; there you resume from inside the session itself.

## What the roster knows about a session

Each roster row tracks the session file its session daemon last used. On its Git-state poll, roughly every ten seconds, the fleet also probes that file for its title and whether it is empty, so the row can show what it is about to resume.

- The session title line appears under the row's title and shows the transcript's title.
- A file that exists but has no messages renders as **New session**.
- The line is absent when there is no stored transcript and no empty session file to report.

## Resume the current session

Clicking the card of a ready or asleep row resumes the session daemon's current session.

- A ready row attaches this browser to the live session. If the row is already attached, the click does nothing.
- An asleep row wakes with its last session file and then attaches. This never opens a picker; see [Start, stop, wake, and remove session daemons](/fleet/session-daemon-operations/).
- A session daemon that has no stored transcript starts a fresh session instead.

## Pick from the last ten sessions

Click the session title line, not the rest of the card, to open the row's session dropdown. It lists that checkout's sessions, newest first, up to ten of them.

- The dropdown answers directly from disk, so it works for an asleep row and for one that has never run in this browser session.
- Each entry shows a display name and a relative modification time such as `5m ago`. The display name is the session title when it has one, otherwise the first user prompt, otherwise a timestamp-based placeholder. Raw session ids are not shown. The entry tooltip carries the session's working directory.
- The transcript currently loaded by that row is highlighted. For the attached row this is the live file; for other rows it is the file a wake would resume.
- While the list loads it shows **loading sessions…**; a checkout with no stored transcripts shows **no sessions yet**; a failure shows the error text in place of the list.

The trigger is part of the row, so it is only available on rows that can act: ready and asleep rows. Transitional rows such as spawning or resolving are not clickable. Opening the row's actions menu closes the dropdown and the other way around, and clicking outside the dropdown or pressing Escape dismisses it.

### What picking an entry does

- **On an asleep row**, the fleet wakes the session daemon with the file you picked and attaches this browser afterward. The file is first checked against that checkout's own session listing, so a path from somewhere else is refused with `session file not in this worktree: <path>` and the row stays asleep. The row shows a waking pulse until the attach settles.
- **On a ready row**, the browser attaches to the session if it is not already attached, then switches the live session to the picked transcript. Picking the file that is already live is a plain attach. The session daemon's process and working directory do not change; only the live conversation does.
- **Other browser tabs attached to the same session daemon** follow the switch, because they share one live session.

A refused or failed resume surfaces in the global error banner, and the row keeps its previous session. If the row has an error status, fix or remove it first; see [Understand roster status](/fleet/roster-status/).

## The onboarding picker

When a session daemon is started through **Start a session now** in the **Add repo** or **Add worktree** dialog, the first attach checks the checkout for existing transcripts.

- If transcripts exist, the History modal opens headed **New session or resume**, newest first, with a **New session** row at the top that starts a fresh session with no history. Selecting a row makes that transcript the live session; Escape also chooses **New session**.
- If no transcripts exist, omp-web starts a fresh session immediately and no modal appears.

This picker is specific to that onboarding flow. Waking a row later never opens it: a wake resumes the last session file, and a specific transcript is chosen from the row's dropdown instead.

## Resume from inside a session

Inside an attached session you have the full history actions:

- `/resume` opens the same History modal, headed **Resume from disk**, filterable by name or working directory. Each row shows the session's directory, message count, and time.
- The **New session** button starts a fresh transcript, asking for confirmation first when the current one is not empty.
- Rename, branch, fork, retry, compact, handoff, and drop operate on the live session and are described in [Manage session history](/sessions/history/).

## Durability and safety

- Transcripts are stored outside the worktree, under the agent directory, so they survive stopping a session daemon, letting it idle out, restarting the fleet, and even deleting the worktree. Locations are listed in the [files reference](/reference/files/), and the model is explained in [Session persistence](/concepts/session-persistence/).
- A transcript has one writer at a time. If a second session daemon tries to resume a transcript another process holds, it refuses to start with a message such as `omp-session: session file <file> is locked by another omp-session (pid <pid>)`. Stop the other process or resume a different transcript; do not delete the lock file. See [Troubleshooting](/operations/troubleshooting/).
- Resuming never moves the row. A session daemon always works in the directory it was started with, so resuming keeps the same checkout and branch.

## CLI and Analysis notes

- The CLI has no resume command. `omp-web prompt <selector> <text>` wakes asleep targets on demand, which resumes their last session file before the prompt is delivered.
- Historical transcripts can be searched and read in the browser's Analysis view, which is fleet-mode only; see [Browse historical transcripts](/analysis/transcripts/).

## Related

- [Projects, worktrees, session daemons, and sessions](/concepts/projects-worktrees-session-daemons-sessions/)
- [Session persistence](/concepts/session-persistence/)
- [Session daemon lifecycle](/concepts/session-daemon-lifecycle/)
- [Start, stop, wake, and remove session daemons](/fleet/session-daemon-operations/)
- [Manage session history](/sessions/history/)
