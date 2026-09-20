---
title: Understand roster status
description: "Read the status dot and activity dot on a roster row: what each session daemon state means, what triggers it, what you can do from that row, and how recovery happens."
---

Every roster row carries two independent signals. The **status dot** at the left of the row describes the session daemon itself: whether it is starting, connected, ready, asleep, or broken. The **activity dot** describes what the live conversation is doing, and it appears only on ready rows. This page explains both, what causes each state, and what to do about the states that need action. For the visual layout of the roster, see [The fleet sidebar](/fleet/sidebar/).

The status and activity dots belong to the roster. The Analysis view replaces the roster sidebar with its own transcripts sidebar, so the dots are visible while the Work view shows the roster column.

## The status ladder

Status moves forward through a fixed ladder while a session daemon starts, then settles into one of the resting states. Hovering a row gives the status in words, and the row is labeled as the active session when this browser is attached to it.

| Status | What it means | What you can do |
| --- | --- | --- |
| spawning | The local process is starting; it has not reported an endpoint yet. | Wait. The row is not clickable while it settles. |
| connecting | The fleet is opening its control connection to the session daemon. | Wait. |
| session | The connection is validated and the session daemon has created or restored the session. | Wait. |
| resolving | The session daemon is resolving its provider, model, and authentication. | Wait. A row that stays here usually has a provider or model problem; see [Troubleshooting](/operations/troubleshooting/). |
| ready | The session daemon accepts prompts and the browser can attach. | Click the row to attach. |
| reconnecting | The control connection dropped and the fleet is redialing automatically. | Wait. |
| asleep | No live process or connection; the row keeps its directory and last session file. | Click the row to wake and attach, or pick a transcript from the title line. |
| error | Terminal failure with a reason recorded on the row. | Open **Daemon details** for the reason, then stop and wake the row, or remove and recreate it. |

Transitional statuses (spawning, connecting, session, resolving) and reconnecting and error rows are deliberately not clickable. A click during those states would race the transition rather than resume anything.

### What the dots look like

- Transitional statuses use a pulsing accent dot, so a starting row reads as busy rather than broken.
- Ready is a solid green dot. Asleep is grey. Reconnecting is amber. Error is red.
- While a wake is in flight the row is highlighted and its dot repaints with the resolving treatment until the attach settles, even though the underlying entry may still be reported asleep.

### Reconnecting and error

**Reconnecting** is automatic. The fleet redials with jittered exponential backoff, starting near one second and growing toward 30 seconds, and it resumes the stream where it left off so frames emitted during the gap are not lost. A reconnecting row is not a failure you must repair; it becomes ready again if the session daemon is alive, and it is only the terminal errors that need action.

**Error** is terminal until you act. The reason is recorded on the row and shown in **Daemon details**, together with the captured standard error output in the log view. Typical reasons include:

- a spawn that failed before the process was usable,
- an endpoint timeout when the process never reported where it is listening,
- an endpoint that is not a valid URL,
- a token rejection or a protocol mismatch between the fleet and the session daemon,
- a working directory mismatch, where the process reports a different directory than the one the row started it in,
- an exhausted restart budget, reported as something like `child exited 6 times (5 restarts allowed)`.

A local row in error can be retried by stopping it and waking it again, which starts a fresh process with a fresh token and resumes the last session file. Removing the row and starting again from the project group is the equivalent for a row that cannot be stopped normally. See [Start, stop, wake, and remove session daemons](/fleet/session-daemon-operations/) for the operations themselves, and [Troubleshooting](/operations/troubleshooting/) for provider and protocol symptoms.

## Activity dots

Activity is reported only for ready rows. An idle ready row keeps its plain green status dot. Four activity states repaint it:

| Activity | When it shows | Cleared by |
| --- | --- | --- |
| in progress | A turn is streaming, on the attached session or reported by the fleet for a detached row. | The turn finishing. |
| blocked | A dialog from an extension is waiting for input. | Answering or dismissing the dialog. |
| unreviewed | The attached session finished a turn while you were scrolled away from the live edge. | Scrolling back to the live edge, sending a prompt, or switching sessions. |
| unread | A detached row finished a turn while you were viewing another session. | Attaching to that row. |

Precedence is fixed, so one dot never contradicts another:

- For the attached session: blocked, then in progress, then unreviewed.
- For a detached row: blocked, then in progress, then unread.

The activity dot is not related to Git state. Uncommitted changes are reported by the row's diffstat chips, which are separate from both dots; a dirty checkout with an idle agent shows the plain ready dot. The row tooltip reports the activity state in words when there is one.

## What triggers transitions

- **spawning → connecting** happens when the spawned process reports its listening endpoint and the fleet dials it.
- **connecting → session → resolving → ready** happens as the connection is validated, the first session state arrives, and the session daemon clears its readiness gate. The ladder only moves forward; earlier statuses are never restored over later ones.
- **any status → reconnecting** happens on an unclean stream end or a failed dial. A clean stream end instead means the session daemon exited, which puts the row asleep.
- **connecting, session, resolving, or ready → asleep** happens on an explicit stop, on the session daemon's idle auto-exit, or on a clean connection close that is not the session daemon reporting a backpressure drop.
- **any status → error** happens on the failure paths listed above. Error is never overwritten by a later transition.

On a fleet restart, persisted rows are reconciled rather than trusted: spawned rows that were not asleep come back asleep because their processes died with the old fleet, remote rows come back connecting and are dialed immediately, and rows that were already asleep or in error keep that state.

## When a worktree disappears under a row

If a worktree directory is deleted outside omp-web, for example in a terminal, the fleet notices within a poll cycle, evicts the row, and shows a toast such as `Worktree removed on disk: <name> (<path>)`. The toast is delivered once per eviction, even to a browser that was disconnected when it happened. This is a different event from deleting a worktree through the UI, which removes the row as part of the deletion and does not raise the toast.

## Related

- [The fleet sidebar](/fleet/sidebar/)
- [Session daemon lifecycle](/concepts/session-daemon-lifecycle/)
- [Start, stop, wake, and remove session daemons](/fleet/session-daemon-operations/)
- [Resume previous sessions](/fleet/resume-sessions/)
- [Safely delete managed worktrees](/fleet/delete-worktrees/)
