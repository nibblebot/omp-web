---
title: Compaction, retry, and recovery
description: Stop a stuck turn, retry failed requests manually or automatically, compact context, reset provider state, and recover a session after a disconnect or an idle shutdown.
---

Sessions run for a long time, and long-running work fails in ordinary ways: a provider returns an error, the context window fills up, a turn needs to be stopped, or the browser loses its stream. This page covers the controls that respond to those situations. History actions such as drop and handoff are compared in [Manage session history](/sessions/history/).

## Stop a running turn

Stop, or Escape in the composer, aborts the running turn. Stopping is explicit: the session does not restart interrupted work on its own. Queued follow-ups then wait until your next message, while a queued steering message still resumes the run; see [Steering, follow-ups, and queues](/sessions/queues/).

Stopping also cancels a pending automatic retry.

## Retry a failed turn

A failed turn leaves an error on the transcript. Two mechanisms can re-run it.

**Manual retry.** `/retry` reruns the last failed assistant turn while the session is idle. When there is nothing to retry, or the session is busy, the stream reports `Nothing to retry; no failed turn or the session is busy.`

**Automatic retry.** When a provider error is classified as transient, the session retries the turn itself:

- A warning notice reports each attempt: `Retrying (attempt N/M): <error>`.
- The status bar shows a live countdown badge, for example `retry 2/5 · 3.2s`, and its tooltip names the attempt.
- The delay respects provider retry hints when the error carries one, and grows with the attempt number.
- Usage-limit errors are retried too, because the session can rotate to another credential for the same provider.
- When retry fallback chains are configured, the session can switch to a different model and then report `Model fallback: <from> → <to>`, followed by `Fallback model <model> succeeded` when the turn recovers.
- When the saga ends, the stream reports `Retry N succeeded` or `Retry N failed: <error>`.

Attempt counts, retry delays, and fallback chains live in Settings under Model, in the Retry & Fallback group. The [configuration reference](/reference/configuration/) owns the exact keys and defaults. Stopping the turn cancels an in-flight retry.

## Compaction

Compaction replaces the older part of the conversation with a summary in the context the provider sees, so a session can continue past its context window. The visible transcript is not rewritten; the stream keeps its messages and gains a compaction card.

**Manual compaction** is `/compact [instructions]`. Any text after the command becomes instructions for the summary. The card records the action as `manual`, the token count before compaction, and the summary itself. A run that did nothing useful reports `skipped`, and an aborted run reports `aborted`; a failure shows its error message instead of a summary.

**Automatic compaction** happens when the session decides context is running out. The stream first shows an info notice, `Compacting context…`, and the status bar shows a `compacting…` badge while the work is in flight. When it settles, the card names what triggered it: `context-full`, `handoff`, `shake`, or `snapcompact`.

Related settings live in Settings under Context, in the Compaction group, including the threshold that triggers automatic compaction. Whether automatic compaction is enabled comes from the session's own setting; the session bar's context meter shows how full the window is, as explained in [Context, tokens, and cost](/analysis/context-tokens-cost/).

Compact is not destructive to the transcript: the session file keeps its entries and gains a compaction record, which the [transcript browser](/analysis/transcripts/) renders as a system entry. Queued messages survive compaction and resume afterwards.

## Reset provider state

`/fresh` closes the session's provider streams and gives it a new provider session id while keeping the transcript. Use it when a provider session has gone stale or when you want a clean provider-side conversation after changing models or providers. The stream reports `Fresh session; provider state reset, transcript kept.`

If a turn is streaming, omp-web asks you to confirm first, because resetting provider state mid-turn can fail the running turn.

## Handoff and drop

When a context is too tangled to compact well, `/handoff [focus]` generates a handoff document with an extra model call and starts a new session that begins from that document. The document appears in the stream as a `handoff` compaction card. This keeps the thread of the work without carrying the whole history forward.

`/drop` is the destructive option: it starts a new session and deletes the previous transcript file. Use it only when you want the conversation gone. Both actions are compared with the rest of the history actions in [Manage session history](/sessions/history/).

## Recovering the connection

The browser stream reconnects by itself. A brief drop is retried natively and the replay resumes from the last event the browser saw; a terminal close is retried with a 1s to 8s backoff ladder. While the stream is down the status bar shows `disconnected`, and the composer waits until the session reports ready again. Reconnection does not lose the session: it lives in the session daemon, not in the tab.

What happens to the session daemon while you are away depends on the mode:

- A running turn keeps running in the session daemon whether or not a browser is attached. Idle auto-exit only fires when the session is otherwise idle: nothing streaming, nothing queued, no shell or Python call in flight, no open dialog, and no attached client.
- In fleet mode, a session daemon that exited appears `asleep` in the roster. Selecting the row wakes it and resumes the recorded session; see [Session daemon operations](/fleet/session-daemon-operations/) and [Roster status](/fleet/roster-status/).
- A crashed session daemon in fleet mode is restarted under supervision. Transcripts are durable, so the resumed session keeps its messages even when the process did not survive.
- In single-session mode there is no supervisor to restart the process after a crash; start the session daemon again and resume the transcript from the picker.

Undelivered queued messages are not part of the transcript and do not survive a session daemon exit. Everything that was delivered is in the transcript.

## Where to look when a failure is not obvious

- The status bar banner carries the last error raised by a call.
- The Debug panel records transport lifecycle events, reconnect delays, and frame activity. It is available from the status bar when the fleet sidebar is not showing its own footer controls.
- Session daemon stderr and logs are reachable from the roster in fleet mode; see [Diagnostics](/operations/diagnostics/).
- [Troubleshooting](/operations/troubleshooting/) maps symptoms such as a stuck `resolving` row, an unauthorized remote connection, or a stale statistics database to their causes.

## Failure cases

- A retry that exhausts its attempts reports the final error and leaves the failed turn in the transcript for a manual `/retry`.
- A provider that rejects the model or the credential stops the retry path early; check provider authentication in [Models and provider authentication](/configuration/models-and-auth/).
- A compaction with no usable model, a cancelled hook, or a compaction error records the failure on the card instead of a summary.
- A session daemon that cannot become ready blocks prompts until it does. Readiness failures and their causes are covered in [Session daemon lifecycle](/concepts/session-daemon-lifecycle/).

## Related

- [Manage session history](/sessions/history/)
- [Steering, follow-ups, and queues](/sessions/queues/)
- [Context, tokens, and cost](/analysis/context-tokens-cost/)
- [Session daemon lifecycle](/concepts/session-daemon-lifecycle/)
- [Session daemon operations](/fleet/session-daemon-operations/)
- [Process lifecycle and recovery](/operations/lifecycle-and-recovery/)
- [Troubleshooting](/operations/troubleshooting/)
