---
title: Manage session history
description: Compare every history action the browser offers, from new and resume to branch, fork, handoff, and drop, and know what each one keeps, copies, or discards.
---

Every conversation is a durable transcript stored on the session daemon's host. The browser exposes a set of history actions that look similar but treat that transcript differently. This page compares them and explains what survives each one. Durability mechanics belong to [Session persistence](/concepts/session-persistence/).

All of these actions target the attached session. `/resume` opens the picker for the attached session daemon; the roster's own per-row pickers are described in [Resume previous sessions](/fleet/resume-sessions/).

## Action comparison

| Action | Reached from | Transcript effect | New session file |
| --- | --- | --- | --- |
| New | `/new`, `/clear`, or the New session button | Replaces the visible conversation with an empty one. The previous transcript stays on disk and can be resumed later. | Yes |
| Resume or switch | `/resume`, or a roster row's session picker | Loads the chosen transcript from disk into the attached session. The current turn is aborted and queued messages are cleared. | No, it reuses the chosen file |
| Rename | `/rename <title>`, or click the session name in the header | None. Only the display name changes. | No |
| Branch | `/branch`, `/tree`, the branch button on a user message, or double-Escape on an empty prompt | Keeps the history up to just before the chosen message. Everything after it is left behind in the original. | Yes |
| Fork | `/fork` | Copies the whole transcript, entries and artifacts, into a new file and continues there. | Yes |
| Fresh provider state | `/fresh` | None. The transcript is kept; provider streams and the provider session id are reset. | No |
| Retry | `/retry` | Reruns the last failed assistant turn after removing it from the active context. | No |
| Compact | `/compact [mode] [focus]` | Replaces older context with a summary while the stream keeps its messages and gains a compaction card. Mode is `soft`, `remote`, or `snapcompact`; anything else is focus text. | No |
| Handoff | `/handoff [focus]` | Generates a handoff document and compacts the context in place: same session identity, same file, recent history kept. | No |

## New, drop, and the confirmation dialogs

`/new`, `/clear`, and the New session button all do the same thing: start a fresh session in a new file. When the current transcript has messages, a confirmation dialog appears first. The previous transcript is kept, so a session you ended by accident is still in the resume list.

`/drop` looks identical but the confirmation text warns that the current session transcript is discarded. On confirmation the previous transcript file and its artifacts are deleted, not just abandoned.

Neither action asks for confirmation on an empty transcript.

## Resume and switch

`/resume` opens the History picker, which lists the session files the attached session daemon can see. Each row shows the session name or a short id, its working directory, its message count, and when it was last modified. The filter box matches on name or working directory.

Choosing a row switches the attached session to that transcript: the running turn is aborted, the messages load, and the model and thinking level come from the session's own record. Queued messages are cleared because they belonged to the session you left.

When the picker is opened as part of onboarding, its heading reads `New session or resume`, it lists sessions newest first, and it offers a `New session` row at the top so you can skip resuming.

## Rename

The session name in the header is editable: click it, type, and press Enter. Escape cancels the edit. `/rename <title>` applies a name directly.

Bare `/rename` is different: it is passed to the agent, which asks the agent to choose a title. Naming does not change the transcript content, and names are how the session is identified in the resume picker and statistical views.

## Branch

Branching is for retrying a request without losing what came before it. The picker lists earlier user messages with a short entry id and an excerpt of the text. Once you choose one:

- A new session file is created containing the transcript up to just before the message you picked. The chosen message is not included, so you can send it again with different wording.
- The original session file is left untouched, and the stream shows `branched at: <excerpt>`.
- A hook in the agent can cancel the branch, in which case the picker reports `Branch cancelled by extension`.
- With no earlier user messages there are no branch points, and the picker says so.

## Fork

`/fork` copies the current session into a new file, including its entries and its artifacts directory, and keeps the full conversation in the active context. The stream reports `Forked session.`, and you continue in the copy. Use it to try a risky direction while keeping a clean line back to the original, without losing the context you already built.

Fork fails, with `Fork failed.`, when a hook cancels it or the session is not persistent.

## Fresh, retry, compact, and handoff

These four keep the conversation but change how the session continues:

- `/fresh` resets provider state while keeping the transcript. While a turn is streaming the browser asks you to confirm first, because resetting provider state mid-turn can fail the running turn. On success the stream reports `Fresh session; provider state reset, transcript kept.`
- `/retry` reruns the last failed turn while the session is idle. When there is nothing to retry, or the session is busy, the stream reports `Nothing to retry; no failed turn or the session is busy.`
- `/compact [mode] [focus]` summarizes the older part of the conversation. The optional first word selects the compaction mode (`soft`, `remote`, `snapcompact`); remaining free text steers the summary. `snapcompact` takes no focus text. This is covered in depth in [Compaction, retry, and recovery](/sessions/recovery/).
- `/handoff [focus]` generates a handoff document with an extra model call and compacts the context in place: the same session keeps its identity and file while older context is replaced by the document. The document also appears in the stream as a `handoff` compaction card, and the free text after the command becomes focus instructions for the summary. If the runtime saved a copy of the document to disk, the stream also links it for download.

## Scope

- `/resume` lists the transcripts the attached session daemon can see. Each roster row also owns its own picker, and the roster decides which session daemon you are attached to; the history actions themselves then behave exactly as described here.
- New, branch, fork, and drop only affect the attached session. Dropping a session deletes its transcript, so it no longer appears in any resume picker. Handoff and compact keep the same session in place.

## Persistence consequences

- New, branch, fork, and drop move the session to a different transcript file; new, branch, and fork keep the previous file on disk, and drop deletes it. Handoff and compact rewrite context in place without changing files.
- The resume picker lists transcripts on disk, so anything a hook cancelled or a dropped session no longer appears.
- A rename is recorded in the transcript as a title change, so it survives a resume and shows up in the transcript browser.
- Actions that change the transcript resync every attached browser tab, not just the one that triggered them.

## Failure cases

- `/resume` or the roster picker shows no sessions when the session daemon's working directory has no transcripts yet.
- Switching can be cancelled by a hook, which reports `Session switch cancelled by extension`.
- A branch can be cancelled by a hook, and a fork can fail; both leave the current session in place.
- The History picker loads sessions from disk. A session whose file was deleted outside omp-web will fail to open.

## Related

- [Compaction, retry, and recovery](/sessions/recovery/)
- [Export and download sessions](/sessions/export/)
- [Session persistence](/concepts/session-persistence/)
- [Resume previous sessions](/fleet/resume-sessions/)
- [Transcripts](/analysis/transcripts/)
- [Slash commands](/reference/slash-commands/)
