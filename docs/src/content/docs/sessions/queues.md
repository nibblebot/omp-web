---
title: Steering, follow-ups, and queues
description: How steering messages reach a running turn, how follow-ups wait for the session, and how the queue bar, queue modes, and pop controls behave.
---

The composer accepts more than one kind of message. A normal prompt starts a turn. A steering message is injected into the turn that is already running. A follow-up is queued for the session and is delivered after the current work settles. This page explains the difference, how delivery works, and how the queue itself is managed. [Prompting the agent](/sessions/prompting/) covers the composer controls themselves.

These controls belong to the attached session, so they work the same in fleet mode and single-session mode. The composer is usable only while the session is ready; see [Start your first session](/getting-started/start-first-session/) if input is refused.

## The three send paths

| What you send | What it does |
| --- | --- |
| Enter with the agent idle | Starts a normal turn. |
| Enter while the agent is streaming, or `-> message` | Sends a steering message to the running turn. |
| Ctrl+Enter (Cmd+Enter on macOS), `=> message`, or `/queue message` | Queues a follow-up for the session. |

The shorthand forms need the space after the arrow. They are parsed before anything else, so a message that begins with `-> ` or `=> ` is queue input, not prose.

Enter never steers an idle session. Steering an idle session has nothing to inject into, so `-> message` falls back to a normal prompt when the agent is not streaming, and the composer's primary button reads `Send` rather than `Steer`. `=> message` queues a follow-up in both states.

## How steering is delivered

A steering message is injected at a tool boundary:

- It is delivered after the tool call that is currently executing finishes, and the remaining calls in that batch are skipped. Steering redirects the run rather than killing it.
- With the session's Interrupt Mode set to `wait`, steering is instead deferred until the running turn completes. The default is `immediate`.
- A steering message that lands while the session is idle (for example typed by another client) still resumes the run, because a queued steer is treated as the opening instruction of the next turn.

Because steering is delivered into the live turn, the agent sees it alongside the work in progress and can adjust course without losing the turn's context.

## How follow-ups are delivered

A follow-up waits for the turn to finish:

- It is delivered only when the agent has no more tool calls or steering messages to process, so it never interrupts a tool batch.
- While the session is idle, queued follow-ups drain automatically and start a turn of their own.
- After you stop a turn with Stop or Escape, a follow-up-only queue is held until your next message. This is deliberate: the session does not restart work you interrupted. A queued steering message does not have that restriction and still resumes the run.
- Compaction preserves the queue and resumes it afterwards.

Both queues are first in, first out. How much of a queue is delivered at one delivery point depends on the queue modes below.

## Queue modes

These session settings live in Settings under Interaction, in the Input group.

| Setting | Values | Effect |
| --- | --- | --- |
| Steering Mode | `one-at-a-time` (default), `all` | Whether one steering message or the whole steering queue is delivered per delivery point. |
| Follow-Up Mode | `one-at-a-time` (default), `all` | The same choice for follow-ups. |
| Interrupt Mode | `immediate` (default), `wait` | Whether steering is checked after each tool call or deferred until the turn completes. |

The modes belong to the session but persist with your agent settings, so a change also applies to future sessions. See [Settings overview](/configuration/settings/) and the [configuration reference](/reference/configuration/) for where these values are stored.

## The queue bar

Whenever the session has queued messages, chips appear above the composer. Each chip is labelled `steer` or `follow-up` and shows a whitespace-flattened preview of the message, truncated after 60 characters.

- The × on any chip, or Alt+Up, pops the most recently queued message back into the composer. The last steering message is popped first, then the last follow-up. Text and images are restored, and text is appended on a new line when you already have a draft.
- `clear all` drains the queued user messages without sending them.
- The status bar shows `queued: N`. That count includes pending work the session queued for itself, so it can be larger than the number of visible chips.

Alt+Down is not a queue control; it only moves through prompt history. The complete shortcut list lives in the [keyboard shortcuts reference](/reference/keyboard-shortcuts/).

## Persistence and safety

Queued messages belong to the running session, not to the transcript:

- They do not appear in the conversation stream, session exports, or historical transcripts until they are delivered.
- Starting a new session or switching to another session clears both queues.
- If the session daemon exits before delivery, including through idle auto-exit, undelivered queued messages are lost. The transcript is unaffected.
- A browser reconnect does not lose the queue, because the queue lives in the session daemon; the queue bar re-reads it after the stream reattaches.

Queued content is only sent when it is delivered or when you explicitly pop it back. Sending a follow-up does not push anything to a provider yet.

## Failure cases

- While the session is not ready, Enter is ignored and the send button is disabled. The pill next to the buttons explains why.
- Empty input is ignored. `/queue` with no text, or input that is only whitespace with no images, does nothing.
- Text that begins with `!`, `!!`, `$`, `$$`, `->`, or `=>` is interpreted as shell, Python, or queue syntax. See [Prompting the agent](/sessions/prompting/) for the prefix rules.
- If the session daemon rejects a send, the error appears in the status bar banner rather than the transcript.

## Related

- [Prompting the agent](/sessions/prompting/)
- [Tool calls, diffs, and images](/sessions/tools-diffs-images/)
- [Compaction, retry, and recovery](/sessions/recovery/)
- [Sessions](/sessions/)
- [Settings overview](/configuration/settings/)
