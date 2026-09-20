---
title: Tool calls, diffs, and images
description: Read the tool activity in a session, switch between expanded, collapsed, and consolidated card views, follow edits as inline diffs, and work with attached images.
---

Most of a session's transcript is tool activity: the agent reading files, searching, editing, running commands, and spawning subagents. Every call renders as its own card, and each family of tools gets a renderer that matches what it does. This page explains the views, the common renderers, how edits appear as diffs, and how images move in and out of the conversation.

Tool output is session data, so it is subject to the persistence rules in [Session persistence](/concepts/session-persistence/). Card views are browser-local display state only; they do not change what the agent sees.

## Card views

A toolbar above the transcript switches between three presentations. It appears once the session has tool cards or a non-default view is selected.

| View | What it shows |
| --- | --- |
| `expanded` | One full card per tool call, the default. |
| `collapsed` | One compact strip per tool call with the tool name, status, and argument summary. |
| `consolidated` | Consecutive tool calls grouped into a single run row, with thinking folded in from the assistant turns that produced them. |

The same toolbar has an `expand` button, equivalent to Ctrl+O. It toggles every tool output open or closed at once and is ignored while you are typing in the composer.

- Long output is previewed at 20 lines while a card is closed. The preview keeps the first 20 lines, except terminal-style output such as bash and eval, which keeps its tail. A note under the preview reports `N hidden lines (Ctrl+O to expand)`.
- Write previews show up to 200 lines until expanded.
- A card stays open while its tool is still running, regardless of the expand-all state, and a manual toggle on a card wins afterwards.

In consolidated view, a run row summarizes the group, for example `4 read • 2 grep • 1 thinking • 7 req • 3 turns`, and expands into the member cards. Assistant prose messages are never folded into a run row; only thinking blocks are, and only when the run follows them directly.

## Common renderers

The session recognizes the usual Oh My Pi tools and falls back to a generic card for anything else:

- `bash` cards show the command as a prompt line with a status badge and the terminal output.
- `read` cards show the file path and numbered lines, reusing the tool's own line numbers when it reported them.
- `grep` and `glob` cards show result lines; clicking a `path:line` prefix copies the path.
- `edit`, `write`, and `apply_patch` cards render the change itself (see below).
- `web_search` cards list the result links.
- `task` cards list the subagents that call spawned, with live status, and link to their transcripts; see [Subagent activity and transcripts](/analysis/subagents/).
- `eval` cards show the code, the live output, and any images the evaluation displayed.
- `lsp`, `hub`, and `todo` cards summarize the operation and keep the full result behind the same expand control.
- `ask` cards show the question, the offered options, and the answer the agent received.
- Any other tool renders as a generic details card with its output and any result images.

A card's status moves through `running`, then `done` or `error`; a failed call keeps its error output on the card. While a settled card is stored in the transcript, its rendered output keeps at most the last 8,000 characters; the complete record stays in the session file and is readable in the [transcript browser](/analysis/transcripts/).

## Shell and Python runs you type

A message that starts with a shell or Python prefix runs on the session daemon instead of going to the model, and it renders as its own terminal card rather than a tool card:

- The card shows the command, a `running` badge with an `abort` button, then an exit badge, the output, and a `(truncated)` note when the output was capped.
- Dimmed variants mark runs whose output is kept out of the agent's context. The prefix table lives in [Prompting the agent](/sessions/prompting/).

## Diffs

`edit`, `write`, and `apply_patch` calls render the change inline instead of dumping arguments:

- Replacements render as a line diff with `+` and `-` markers and the surrounding context.
- Runs of unchanged lines longer than the context window collapse into a `N unchanged lines` marker, so a small edit in a large file stays readable.
- A `write` renders the new file content with line numbers, previewed at up to 200 lines until expanded.
- Other shapes fall back to the generic card with the raw output.

Nothing is applied by looking at a card. The file on disk changed only when the tool call completed successfully; a staged or previewed edit that was never resolved is not a change.

## Images

Images enter a session in two places.

**Attached to your messages.** Paste an image into the composer and it appears in the image tray as a thumbnail with a Remove image button. Images travel with normal prompts, steering messages, and queued follow-ups, and a popped queued message restores its images to the tray. There is no file picker in the composer. A message with images and no text is a valid send.

**Returned by tools.** Tool results that carry image payloads render them as inline thumbnails on the card, including provider screenshot shapes. Clicking any thumbnail, in your message or on a tool card, opens a full-size overlay. Escape or a backdrop click closes it.

Image handling is configured in Settings:

- `images.autoResize` resizes large images to a maximum of 2000x2000 for provider compatibility. On by default.
- `images.blockImages` prevents images from being sent to providers at all. Off by default.
- `images.describeForTextModels`, under Model in the Vision group, has a vision model describe attachments when the active model cannot accept images. The description is sent as hidden context next to your message, and the image is also saved in the session's local file space so the agent can inspect it later. On by default.
- `inspect_image.mode` controls how the agent's own image inspection tool routes an image.

The [configuration reference](/reference/configuration/) owns the full setting list and defaults.

## Failure cases

- A tool that fails settles with the `error` status and its error text on the card.
- Images are refused by a provider only when `images.blockImages` is on; otherwise an unsupported model relies on the description fallback.
- Tool output limits are display limits. If a card looks truncated, open the [transcript browser](/analysis/transcripts/) for the full entry.

## Related

- [Prompting the agent](/sessions/prompting/)
- [Steering, follow-ups, and queues](/sessions/queues/)
- [Session persistence](/concepts/session-persistence/)
- [Context, tokens, and cost](/analysis/context-tokens-cost/)
- [Subagent activity and transcripts](/analysis/subagents/)
- [Keyboard shortcuts](/reference/keyboard-shortcuts/)
