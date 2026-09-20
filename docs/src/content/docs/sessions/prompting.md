---
title: Prompting the agent
description: Send prompts, steer running turns, queue follow-ups, attach images, use completion and agent dialogs, and search browser-local prompt history in the omp-web composer.
---

The composer at the bottom of the conversation is where you talk to the attached session daemon. It handles more than plain prompts: steering messages for a turn that is already running, queued follow-ups, slash commands, shell and Python input, and pasted images. Completion, agent dialogs, tool output views, and prompt history live around it.

This page assumes an attached, ready session. If the composer refuses input, see [Start your first session](/getting-started/start-first-session/).

## Before you can send

The composer accepts input only while the attached session daemon reports ready. Until then, Enter is ignored and the Send button is disabled; the disabled button explains why with `Not connected`, `The attached session is not ready yet…`, or `The agent is still starting…`.

The pill next to the buttons tracks startup:

- In single-session mode it reads `starting…` while the agent resolves a provider and model.
- In fleet mode it describes the attach state instead, for example `attaching to daemon…` or `daemon <status>…`.
- In fleet mode with no session attached at all, the conversation column is replaced by a prompt to pick a session daemon in the sidebar.

## Send a normal prompt

Type in the textarea and press Enter, or click Send.

- Enter sends a normal prompt while the agent is idle, and steering input while a turn is streaming.
- Shift+Enter inserts a newline.
- Input that is only whitespace, with no images, is ignored.
- Text is trimmed before sending, and an image-only message is a valid send.
- A sent prompt clears the textarea and the image tray, and the text is recorded in prompt history.

The placeholder lists the common keys: `Message the agent… (Enter send, Ctrl+Enter follow-up, / for commands)`. The action row also contains New session, which behaves like `/new`: it asks for confirmation when the transcript is not empty and then replaces the current session.

On an empty transcript, suggested prompts such as "Summarize this repo" insert text into the composer without sending it.

If the session daemon rejects a send, the error appears in the status bar banner instead of the transcript.

## Steer a running turn

While the agent is streaming, Enter sends your text to the running turn as steering input, and the primary button changes from Send to Steer. The shorthand is `-> message`, and the space after the arrow is required:

- `-> message` steers while a turn is streaming.
- The same input sends an ordinary prompt while the agent is idle, because steering an idle session is invalid.

Steering messages go to the running turn. Anything still waiting, of either queue kind, shows up in the queue bar above the composer, and the status bar shows `queued: N`.

## Queue a follow-up

A follow-up is queued for the session instead of steering the running turn:

- Ctrl+Enter (Cmd+Enter on macOS) queues the composed message as a follow-up, whether or not a turn is streaming.
- `=> message` queues a follow-up, with the same required space after the arrow.
- `/queue message` queues a follow-up too.

Queued messages appear as chips above the composer, labelled `steer` or `follow-up` and showing a whitespace-flattened preview truncated after 60 characters. The `clear all` button drains the whole queue.

Alt+Up, or the × on any chip, pops the last queued message back into the composer: its text and images are restored, and the text is appended on a new line when you already have a draft. The × is a pop control rather than per-chip deletion.

## Attach pasted images

Paste an image into the composer and it is attached to the message as a thumbnail. Non-image paste keeps the normal paste behavior, and there is no file-picker button in this composer.

Each thumbnail has a Remove image button. Images are held in the composer until you send them, and they travel with normal prompts, steering messages, and queued follow-ups alike. Popping a queued message restores its images to the tray.

## Completion and file mentions

Two completion sources open as you type:

- `/` at the very start of the message completes slash commands.
- `@` at the start of the message or after whitespace completes file paths.
- Neither opens inside a fenced code block.
- Matching is case-insensitive fuzzy: exact, then prefix, then subsequence.

While the popup is open:

- Up and Down move the selection and wrap around the list.
- Tab applies the highlighted result.
- Enter applies the highlighted result unless you have already typed that exact `/command` or `@file`, in which case Enter submits the message.
- Escape dismisses the popup; typing re-enables it.

Slash results merge commands the web UI handles itself with commands advertised by the session daemon, and a local command wins a name collision. Commands the web UI does not handle are sent to the agent verbatim, so server-side builtins, skills, extensions, and file commands can respond to them.

`@` matches come from a server-side file walk that runs after a short debounce. Applying a file inserts the path with a trailing space and quotes the path when it contains spaces.

## Shell and Python prefixes

A message that begins with one of these prefixes is interpreted rather than sent as prose:

| Prefix | Behavior |
| --- | --- |
| `! command` | Runs a shell command; its output goes into the agent's context. |
| `!! command` | Runs a shell command with output kept local (dimmed). |
| `$ code` | Runs Python; its output goes into the agent's context. |
| `$$ code` | Runs Python with output kept local (dimmed). |
| `-> message` | Steering shorthand. |
| `=> message` | Follow-up shorthand. |

Shell and Python commands render as their own transcript cards with live output while they run. Because prefixes are matched first, a prompt that begins with `!`, `$`, or an arrow followed by a space is treated as a command, not as text.

## Tool views and Ctrl+O

Tool calls render as cards in the transcript. The toolbar above the transcript switches between three card views:

- expanded: a full card per tool call.
- collapsed: a condensed strip per tool call.
- consolidated: consecutive tool calls grouped into one run row.

Ctrl+O toggles expand-all for tool output, the same control as the expand button in the toolbar. It is ignored while you are typing in the composer, and it does not fire with Shift or Alt held. While a card's output is collapsed it shows the first 20 lines, followed by an `N hidden lines (Ctrl+O to expand)` note; write previews show up to 200 lines until expanded. Cards stay open while their tool is still running.

## Answer agent dialogs

When the agent or an extension needs a decision, a modal appears over the session, and the session daemon is blocked on your input until you answer. The roster marks such a row with a blocked activity indicator.

- Ask (titled `Agent asks`): a multi-question form. Questions can be single-select or multi-select, a `recommended` badge marks the suggested option, and each question offers an `Other…` field for a custom answer. Submit is disabled until every question has an answer.
- Select: a titled option list; clicking an option answers with its label.
- Confirm: the request's title and message, with OK answering yes and Cancel answering no. Closing the dialog with Escape or the backdrop cancels the request instead of answering it.
- Input: a single-line text field with Submit.
- Editor: a multiline editor, prefilled by the agent, with Submit.

Cancelling a dialog resolves the request as cancelled, and the agent sees that the question was not answered.

## Stop a running turn

Escape aborts the running turn while the agent is streaming, exactly like the Stop button in the action row.

When nothing is streaming, Escape is part of a chord:

- Press Escape twice within half a second with an empty prompt to open the branch picker.
- Escape with text in the prompt resets the chord.
- If the completion popup is open, Escape closes the popup first.

## Prompt history and Ctrl+R are browser-local

Prompt history belongs to your browser, not to the session daemon or the session transcript. It is stored in local storage under `omp-web:history`, keeps at most 100 entries from oldest to newest, and collapses consecutive duplicates.

- Up recalls the previous entry when the caret is on the first line of the prompt.
- Down moves toward newer entries only while you are browsing, when the caret is on the last line, and eventually restores the draft you had before browsing.
- Ctrl+R opens History search, a fuzzy newest-first filter over the same entries. Up and Down move the selection without wrapping, Enter or a click inserts the entry into the composer, and Escape closes the dialog. With no matches it shows `no matching history`. Ctrl+R is ignored while another modal is open.

History follows the browser profile: a different browser, a different profile, or cleared site data starts empty.

## Ask a side question with /btw

`/btw question` opens the side-question panel and streams an answer without touching the conversation. Neither the question nor the reply enters the transcript, and the running turn is unaffected. Bare `/btw` opens the panel empty with a usage hint.

The panel offers stop and close controls. Closing it while an answer is still streaming aborts the side question on the session daemon; Escape and the backdrop close it too.

## Related

- [Start your first session](/getting-started/start-first-session/)
- [Interface tour](/getting-started/interface-tour/)
- [Projects, worktrees, session daemons, and sessions](/concepts/projects-worktrees-session-daemons-sessions/)
- [The fleet sidebar](/fleet/sidebar/)
- [Troubleshooting](/operations/troubleshooting/)
