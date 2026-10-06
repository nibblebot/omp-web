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
| `/new` | none | Starts a new session (`newSession`). | Confirmation when the transcript has items, then the transcript is replaced and every open tab resyncs. |
| `/clear` | none | Clears context in place, keeping session id, title, and file (`clearSession` → `resetSessionContext`). | The transcript resyncs to the cleared context; a notice reports the dropped count. Refused with a warning while a turn is streaming. |
| `/delete` | none | Deletes the current session and starts a replacement (`deleteSession`); confirmation names the exact session ID. | Confirmation first, then the replacement transcript with every open tab resynced. Durable deletion failures report instead of a false success. |
| `/resume` | `[session-id\|@claude\|@codex]` | Bare opens the History picker (`list_sessions`); an id arg switches the attached session to that transcript directly (`switchSession`). Unknown ids report the switch error. | Picker, or the switched transcript with every tab resynced. |
| `/tree`, `/branch` | none | Opens the Branch session picker over earlier user messages (`getBranchMessages`). | Picking a message branches from it, closes the picker, and posts a `branched at: ...` notice. An extension can cancel, which is reported in the picker. |
| `/btw` | question (optional) | Opens the side-question panel. With a question it starts a side turn (`runEphemeralTurn`) that never enters the transcript. | The reply streams into the panel; stop or close aborts a streaming reply. Bare `/btw` opens the panel with a usage hint. |
| `/export` | `--themes` (optional), `[path]` (optional) | Exports the session to HTML (`exportHtml`). `--themes` carries the active web theme into the export; a path sets the server-side output path. | A transcript notice names the exported file's path on the session daemon's host. |
| `/retry` | none | Retries the last failed assistant turn when the session is idle (`retry`). Extra args report usage. | The retried turn streams. If there is no failed turn or the session is busy, a notice says there is nothing to retry. |
| `/fork` | none | Forks the session history in place (`fork`). Extra args report usage. | The transcript resyncs and a notice reports `Forked session.` or `Fork failed.` |
| `/fresh` | none | Resets provider state and keeps the transcript (`freshSession`). Extra args report usage. | Confirmation first while a turn is streaming. On success a notice reports the reset and the transcript is unchanged. |
| `/handoff` | focus (optional) | Generates a handoff document and compacts the context **in place** — same session identity, same file, recent history kept (`handoff`). | A `compaction (handoff)` card shows the document plus a `Handoff complete. Context compacted in place.` notice; a saved-path notice follows when the session daemon wrote one. Cancel reports `Handoff cancelled.` |
| `/dump` | `[all]` (optional) | Bare downloads the transcript as plain text and requests the last LLM request dump (`formatSessionAsText`, `dumpLlmRequestToTmpDir`). `/dump all` requests the bounded server archive. Unknown args report usage. | `transcript.txt` downloads in the browser; notices cover an empty transcript and name the LLM request dump's path when one exists. `/dump all` is not yet available in the browser and says so explicitly. |
| `/rename` | title (optional) | With a title, sets the session name immediately (`setSessionName`), with no model turn. Bare, forwards `/rename` to the agent. | The new title appears in session listings. Bare `/rename` is answered by the agent-side builtin with its usage message in a notice. |
| `/goal` | `set <objective>`, `show`, `pause`, `resume`, `drop`, `budget <N\|off>`, or none | Creates, pauses, resumes, or drops the session goal. `show` and `budget` open the Goal panel (budget adjustment lands with the P4 goal service); bare, unknown subcommands, and `set` with no objective open the Goal panel. | The goal badge in the status bar and the Goal panel update from session state. Creating a goal while one is active is refused. |
| `/plan` | `[prompt]` (optional) | Bare toggles plan mode (`setPlanModeState`); with a prompt, enters plan mode with that prompt as the first plan turn. | The plan badge in the status bar turns on or off, with a notice when a prompt starts the plan. |
| `/queue` | message | Queues a follow-up message for the session (`followUp`). | The message appears in the queue bar and is delivered in turn order, which is immediate when the session is idle. An empty message is ignored. |
| `/compact` | `[soft\|remote\|snapcompact] [focus]` | Runs manual context compaction (`compact`). An unknown first token is focus text; `snapcompact` with focus reports usage. | A `compaction (manual)` card appears with the summary and, when reported, the token count. |
| `/model` | `[provider/id]` (optional) | Bare opens the model picker; a selector sets the session model directly (`setModel`), resolved against live discovery. | Picker, or a `Model set to provider/id.` notice; unknown selectors report the miss. |
| `/move`, `/wt`, `/worktree` | — | Refused explicitly for attached fleet sessions: the daemon checkout is immutable while attached (`moveSession` would desynchronize roster/session files/artifacts). | An error notice naming the fleet alternative (sidebar for moves, Add-workspace modal for worktrees). |

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

	- `/new` asks when the transcript has items. The dialog is titled `Start a new session`, and its confirm button reads `New session`.
	- `/delete` always asks, with a body that names the exact session ID and a `Delete session` confirm button.
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
