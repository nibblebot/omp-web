---
title: Slash commands
description: "Canonical reference for every slash command the omp-web composer handles itself, with arguments, confirmations, results, and how other commands reach the agent."
---

The composer handles a fixed set of slash commands in the browser. They act on the attached session and are interpreted by the web UI, not by the model. A message that starts with `/` and does not name one of these commands is forwarded to the attached session daemon as a regular prompt, where the agent's own command handling takes over.

This page is the canonical table. [Prompting the agent](/sessions/prompting/) explains the composer around it, including queues, images, and completion.

## How slash input is parsed

- A message is a slash command only when its first non-whitespace character is `/` and at least one non-whitespace character follows it. Leading and trailing whitespace is trimmed first, and a lone `/` is an ordinary prompt.
- The command name runs to the first whitespace character and is matched case-insensitively, so `/HELP` runs `/help`.
- Everything after the whitespace run following the name is the argument string. Arguments can contain spaces and line breaks, and each command trims or normalizes them as it needs.
- The whole message is the command. There is no chaining, no quoting syntax, and no way to pass one command's output to another.
- The follow-up modifier (Ctrl+Enter, or Cmd+Enter on macOS) does not change slash dispatch. A submitted slash command always runs as a command; the modifier only changes how plain text is sent.

## Scope and readiness

- Slash commands work the same everywhere in the fleet-served UI. Every command targets the attached session; none of them manage the fleet, projects, worktrees, or session daemons. Use the sidebar for those operations.
- With no session attached, the conversation column is replaced by the session picker prompt, so there is no composer to type into.
- The composer refuses input until the attached session daemon reports ready. Until then the Send button is disabled, Enter is ignored, and the ready pill explains the wait.
- If a prompt-family call arrives early anyway, the session daemon rejects it with `not_ready`. The gated methods are `prompt`, `steer`, `followUp`, `abortAndPrompt`, and the side turn behind `/btw`.
- A command that fails puts a message in the status bar error banner, which you can dismiss. Successful commands report through the transcript: a notice line, a card, or a panel.

## Command table

| Command | Arguments | Action | What you see |
| --- | --- | --- | --- |
| `/new`, `/clear` | none | Replaces the current session with a new one (`newSession`). | Confirmation when the transcript has items, then the transcript is replaced and every open tab resyncs. |
| `/drop` | none | Same new-session action, with a confirmation that warns the transcript is discarded. | Confirmation when the transcript has items, then the transcript is replaced. |
| `/resume` | none | Opens the History picker, which lists session files on disk for the attached directory (`list_sessions`). | Picking an entry switches the attached session daemon to that session and resyncs the transcript. |
| `/tree`, `/branch` | none | Opens the Branch session picker over earlier user messages (`getBranchMessages`). | Picking a message branches from it, closes the picker, and posts a `branched at: ...` notice. An extension can cancel, which is reported in the picker. |
| `/btw` | question (optional) | Opens the side-question panel. With a question it starts a side turn (`runEphemeralTurn`) that never enters the transcript. | The reply streams into the panel; stop or close aborts a streaming reply. Bare `/btw` opens the panel with a usage hint. |
| `/export` | `--themes` (optional) | Exports the session to HTML (`exportHtml`). `--themes` carries the active web theme into the export; any other argument is ignored. | A transcript notice names the exported file's path on the session daemon's host. |
| `/retry` | none | Retries the last failed assistant turn when the session is idle (`retry`). | The retried turn streams. If there is no failed turn or the session is busy, a notice says there is nothing to retry. |
| `/fork` | none | Forks the session history in place (`fork`). | The transcript resyncs and a notice reports `Forked session.` or `Fork failed.` |
| `/fresh` | none | Resets provider state and keeps the transcript (`freshSession`). | Confirmation first while a turn is streaming. On success a notice reports the reset and the transcript is unchanged. |
| `/handoff` | focus (optional) | Starts a new session carrying a summary document; the focus text becomes the handoff instructions (`handoff`). | The transcript resyncs, a `compaction (handoff)` card shows the document, and a notice names the saved document's path when the session daemon wrote one. |
| `/dump` | none | Downloads the transcript as plain text and requests a dump of the last LLM request (`formatSessionAsText`, `dumpLlmRequestToTmpDir`). | `transcript.txt` downloads in the browser; notices cover an empty transcript and name the LLM request dump's path when one exists. |
| `/rename` | title (optional) | With a title, sets the session name immediately (`setSessionName`), with no model turn. Bare, forwards `/rename` to the agent. | The new title appears in session listings. Bare `/rename` is answered by the agent-side builtin with its usage message in a notice. |
| `/goal` | `set <objective>`, `pause`, `resume`, `drop`, or none | Creates, pauses, resumes, or drops the session goal. Bare, unknown subcommands, and `set` with no objective open the Goal panel. | The goal badge in the status bar and the Goal panel update from session state. Creating a goal while one is active is refused. |
| `/plan` | none | Toggles plan mode (`setPlanModeState`). | The plan badge in the status bar turns on or off. |
| `/queue` | message | Queues a follow-up message for the session (`followUp`). | The message appears in the queue bar and is delivered in turn order, which is immediate when the session is idle. An empty message is ignored. |
| `/compact` | instructions (optional) | Runs manual context compaction, with the instructions when given (`compact`). | A `compaction (manual)` card appears with the summary and, when reported, the token count. |
| `/model` | none | Opens the model picker. | Choose a model role, then a model, then a thinking level when that model exposes one. |
| `/usage`, `/context`, `/tools` | none | Opens Session stats. | Token, message, and tool counts, the context breakdown, the tool list, and the compaction controls. |
| `/help`, `/hotkeys` | none | Opens the shortcuts dialog. | A modal listing the keyboard bindings. |
| `/exit`, `/quit` | none | Nothing to quit: the session outlives the browser tab. | A notice explains that the session persists and that closing the tab is how you leave. |

## Examples

```
/new                      # start a new session; confirms first when the transcript has items
/resume                   # pick an earlier session stored on disk
/compact focus on the parser changes
/handoff continue from the API refactor
/goal set ship the release checklist
/queue run the full test suite when this turn ends
/export --themes
/dump
```

An unhandled name, for example `/outline the remaining work`, is forwarded to the attached session daemon with its text intact. Whether the agent answers it with one of its own command handlers or the model sees it as an ordinary prompt depends on the agent's command set; the completion list shows the commands the session daemon advertises.

## Confirmations

Three groups ask before acting:

- `/new` and `/clear` ask when the transcript has items. The dialog is titled `Start a new session`, and its confirm button reads `New session`.
- `/drop` asks under the same condition, with a body that warns the transcript is discarded and a `Drop session` confirm button.
- `/fresh` asks while a turn is streaming, because resetting provider state mid-turn can fail the running turn. Its confirm button reads `Reset state`.

Cancel, Escape, and the backdrop close a confirmation without running the action. Opening a new confirmation replaces any confirmation still pending.

## Files produced by commands

- The transcript download from `/dump` is assembled in the browser, so it saves straight to your machine.
- `/export` and the LLM request dump from `/dump` write server-side files on the machine that runs the session daemon, and their notices name those paths. The browser never resolves the session daemon's `/download` route, because the browser's origin is the fleet, which does not proxy it; retrieve the files on that host. See [Export and download sessions](/sessions/export/).

## Commands the web UI does not handle

Any other message beginning with `/` is forwarded to the attached session daemon as a normal prompt, with its original text and case. On the session daemon the input first goes through the agent's text-mode builtin dispatch:

- A builtin that handles the command consumes it, so the command text never reaches the model as a prompt. Its text output arrives in the transcript as a notice.
- Some builtins instead hand a rewritten prompt to the model.
- Input no builtin consumed continues through the agent's own command handling, which covers extension commands, custom commands, MCP prompts, and project command files. Anything still unresolved reaches the model as ordinary prompt text.

The session daemon advertises the commands it knows, and the composer's completion list merges them with the local table. A local command wins a name collision, so the behavior in the table above always applies to those names. Commands that belong to the terminal UI have no browser surface and will not drive the same dialogs here.

## Related

- [Prompting the agent](/sessions/prompting/)
- [Keyboard shortcuts](/reference/keyboard-shortcuts/)
- [Reference](/reference/)
- [Start your first session](/getting-started/start-first-session/)
- [The fleet sidebar](/fleet/sidebar/)
