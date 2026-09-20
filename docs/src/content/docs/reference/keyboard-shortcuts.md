---
title: Keyboard shortcuts
description: Every keyboard shortcut in the omp-web browser UI, by context, with platform differences, gated states, precedence, and browser key conflicts.
---

This page is the canonical list of keyboard shortcuts in the omp-web browser UI. The shortcuts are built into the web client, work everywhere in the fleet-served UI, and are not configurable; there is no keymap setting. A surface that is not on screen, such as the roster while Analysis is showing, has no shortcuts to fire.

Shortcuts act on the focused element, so each section states its scope. `Ctrl` means Control on every platform; `Cmd` means Command on macOS. Terminal and TUI key handling is outside this reference.

The app carries a shorter version of this list. Run `/help` or `/hotkeys` to open the Shortcuts dialog, and see the [slash command reference](/reference/slash-commands/) for the full command set. The composer placeholder names the three most common keys: `Message the agent… (Enter send, Ctrl+Enter follow-up, / for commands)`.

## Composer

Scope: focus in the prompt textarea at the bottom of the conversation column.

### Sending, steering, and the queue

| Key | Action |
| --- | --- |
| Enter | Sends the message. While a turn is streaming it becomes steering input for that turn; when the session is idle it starts a normal turn. |
| Shift+Enter | Inserts a newline. |
| Ctrl+Enter or Cmd+Enter | Queues the message as a follow-up, whether or not a turn is streaming. |
| Alt+↑ (Option+↑ on macOS) | Pops the last queued message back into the composer with its text and images. |

- Until the attached session is ready, Enter and Ctrl+Enter or Cmd+Enter are consumed and ignored: nothing is sent and no newline is inserted. Shift+Enter still inserts a newline. The Send button stays disabled and the ready pill explains the startup state; see [Start your first session](/getting-started/start-first-session/).
- Text is trimmed before sending, and whitespace-only input with no images is ignored. A send clears the textarea and the image tray.
- Alt+↑ is a no-op when the queue is empty, and the default caret movement is suppressed in either case. The × control on a queue chip performs the same pop.
- Popping appends the restored text on a new line when you already have a draft.

### Escape

| Key | Action |
| --- | --- |
| Escape | While a turn is streaming, aborts it, like the Stop button. |
| Escape, Escape | Opens the branch picker when the composer is empty, like `/tree` and `/branch`. |

- The two presses must land within 500 ms of each other and the composer must be empty. Escape with text in the composer resets the chord.
- Escape while streaming aborts and resets the chord, so the double-press picker is unavailable until the turn stops.
- When the completion popup is open, Escape dismisses the popup and resets the chord instead.
- An abort the session daemon rejects surfaces as an error banner in the status bar.

### Prompt history

| Key | Action |
| --- | --- |
| ↑ | Recalls the previous (older) history entry. |
| ↓ | Moves toward newer entries; past the newest it restores the draft stashed when browsing began. |

- ↑ acts only when the caret is on the composer's first line. With no stored entries it does nothing and the caret moves normally.
- ↓ acts only during a browse and only when the caret is on the last line.
- History is browser-local: up to 100 entries under the `omp-web:history` local-storage key, oldest to newest, with consecutive duplicates collapsed. It is not part of the session or the transcript.
- Ctrl+R opens a searchable version of the same history; see [Application-wide keys](#application-wide-keys).

### Completion popup

Scope: focus in the composer while the popup is open. The popup opens for a `/` token at the very start of the message, or an `@` token at the start of the message or after whitespace, and stays closed inside a fenced code block.

| Key | Action |
| --- | --- |
| ↑ / ↓ | Move the selection through the ranked results, wrapping at both ends. |
| Tab | Applies the highlighted result. |
| Enter | Applies the highlighted result, unless the typed token already equals that result exactly, in which case the message is sent (queued when Ctrl or Cmd is held). |
| Escape | Dismisses the popup and clears the token; typing re-enables completion. |

- Matching is case-insensitive fuzzy: exact, prefix, then subsequence.
- Slash results merge commands the web client handles itself with commands the session daemon advertises, and the client wins a name collision.
- `@` results come from a server-side file walk after a short debounce. Applying one inserts the path with a trailing space and quotes paths that contain spaces.
- At most 12 results are shown, and the list grows to keep the highlighted row visible.
- Alt+↑ is handled before the popup, so it pops the queue even while the popup is open.
- The prefixes `->`, `=>`, `!`, `!!`, `$`, `$$`, and `/command` are prompt grammar evaluated at send time, not key presses. See [Prompting the agent](/sessions/prompting/) for their behavior.

## Transcript and tool output

Scope: the transcript scroll container, which receives keys only from focused descendants. In practice that means a link, button, or details summary inside a message; keys pressed anywhere else, including in the composer, do not reach it.

### Scrolling

| Key | Action |
| --- | --- |
| PageUp | Scrolls up one viewport and detaches the viewport from the live edge. |
| PageDown | Scrolls down one viewport; re-attaches if the viewport lands within the bottom 80 px. |
| ↑ | Scrolls up 40 px and detaches. |
| ↓ | Scrolls down 40 px, re-attaching inside the bottom band. |
| Home | Jumps to the top of the transcript and detaches. |
| End | Jumps to the bottom and re-attaches. |
| Shift+Space | Pages up. |

- Detaching stops the viewport from following streamed output until a downward gesture lands in the bottom band; the jump-to-bottom button and End re-attach. At the very top of the transcript there is nothing above to detach into, so an up key leaves the viewport attached.
- Home, End, and Shift+Space are skipped when the focused element is interactive, meaning a button, link, input, textarea, select, or summary. Arrow keys and the Page keys are not skipped there, so they scroll the transcript even with a nested control focused.
- Space alone activates the focused button or link instead of paging.

### Tool output

| Key | Action |
| --- | --- |
| Ctrl+O | Toggles expand-all for tool output. |

- The key is handled application-wide. It is ignored while the event target is a textarea or input, and it does not fire with Shift or Alt held. It requires Ctrl, so Cmd+O is not intercepted.
- It applies in the expanded and collapsed tool card views. In the consolidated view, consecutive calls collapse into run rows with their own expand controls, which Ctrl+O does not open.
- Collapsed output shows the first 20 lines followed by an `N hidden lines (Ctrl+O to expand)` note, and write previews show up to 200 lines until expanded. A card stays open while its tool is still running.
- With no tool output on screen the toggle still flips its stored state but shows no visible change.

## Dialogs, menus, and lists

These keys apply while a dialog, menu, or dropdown is open, or to the focused row, tab, or field in any view.

| Surface | Key | Action |
| --- | --- | --- |
| Every dialog (settings, models, thinking, stats, usage, history search, session picker, branch, goal, login, debug, worktree, add project, subagents, help, agent dialogs, danger and confirmation dialogs) | Escape | Closes the dialog. The dialog handles Escape in the capture phase and stops the event, so the key does not also reach the composer. |
| Every dialog | Tab / Shift+Tab | Keeps focus inside the dialog: Tab on the last focusable control wraps to the first, and Shift+Tab on the first wraps to the last. |
| Full-size image preview | Escape | Closes the preview. |
| Onboarding session picker | Escape | Chooses New session instead of closing. Outside the onboarding gate, Escape closes the picker like any other dialog. |
| Kebab menus and roster session dropdowns | Escape | Closes the menu. An outside click does the same. |
| Buttons, picker rows, menu items | Enter or Space | Activates the focused control. Picker rows are real buttons, so this is their native behavior. |
| Roster rows, the session title line, subagent rows, model-role rows | Enter or Space | Activates the row when the row itself is focused; a nested control keeps its own keys. |
| Session title, not renaming | Enter or Space | Opens the rename field. |
| Session rename field | Enter / Escape | Commits the new name / cancels. Clicking away also cancels. |
| History search field | ↑ / ↓ | Moves the selection through the fuzzy newest-first results without wrapping. |
| History search field | Enter | Inserts the selected entry into the composer and closes the dialog. A click does the same. With no matches the list shows `no matching history`. |
| Login code field | Enter | Submits the entered code. |
| Model picker filter | Enter | Picks the first model in the filtered list. |
| Settings text field | Enter | Commits the value. |
| Subagent steer field | Enter | Sends the steer message to that subagent. |
| Analysis tabs (Overview, Transcript, Subagents) | ArrowRight or ArrowDown / ArrowLeft or ArrowUp / Home / End | Moves focus to the next, previous, first, or last tab. Enter or Space activates the focused tab. |
| Analysis tool table row | Enter or Space | Filters the transcript by that tool. |
| Goal creation, worktree creation, directory path, and agent input forms | Enter | Submits the form where the browser's implicit submission applies, because the field is the form's only text field or the form has a submit button. |
| Agent editor dialog | Enter | Inserts a newline in the multiline editor; use Submit to answer. |
| Agent ask dialog | Enter or Space | Activates the focused option. Submit stays disabled until every question has an answer. |
| Agent dialogs | Escape | Cancels the request, and the agent sees the question as unanswered. |

- Dialogs restore focus to the control that opened them when it still exists.
- Closing the `/btw` side panel with Escape or the backdrop while its answer is streaming aborts that side question. The main conversation is not affected.
- A backdrop click closes a dialog, image preview, menu, or dropdown, just like Escape.
- Two-click confirm controls such as stop, remove, and abort arm on the first activation and fire on the second. A keyboard activation counts as the first or second click.

## Application-wide keys

Scope: the whole page, subject to the guards in the table.

| Key | Action | Guard |
| --- | --- | --- |
| Ctrl+O | Toggles expand-all for tool output. | Ignored when the event target is a textarea or input. Requires Ctrl with Shift and Alt up. Fires even while a dialog is open when focus is not in a text field. |
| Ctrl+R | Opens History search. | Ignored while one of the standard dialogs is open (picker, settings, help, model, thinking, stats, usage, subagents, history, branch, login, goal, debug, worktree, add project). Works while the composer has focus. Requires Ctrl with Shift and Alt up. |

- Both keys call `preventDefault` when they match, so the browser's own Ctrl+O and Ctrl+R do not run.
- Cmd+O and Cmd+R are not intercepted on macOS, because the handlers require Ctrl. Cmd+R reloads the page. A reload loses only unsent composer input, including an attached image tray; the session, its queue, and its transcript are durable and continue on the session daemon.
- When a guard fails, the browser default runs instead: on Windows and Linux, Ctrl+O while typing opens the browser's file-open dialog, and Ctrl+R while a dialog is open reloads the page.
- The Ctrl+R guard covers the standard dialogs listed above. An agent dialog, the `/btw` side panel, or a confirmation dialog does not suppress it, so Ctrl+R can open History search on top of those.
- No other page-wide shortcut is registered. Switching between Work and Analysis, opening the sidebar, opening settings, and starting a new session are pointer-only controls.

## Precedence and conflicts

The composer inspects each keydown in this order:

1. Alt+↑ pops a queued message.
2. While the completion popup is open, ↑, ↓, Tab, and Escape belong to the popup; Enter completes unless the typed token is an exact match.
3. Escape aborts a streaming turn.
4. Escape starts or continues the branch-picker chord.
5. Enter sends, or queues a follow-up when Ctrl or Cmd is held; Shift+Enter returns before this point and inserts a newline.
6. ↑ and ↓ fall back to prompt history.

Consequences worth remembering:

- Alt+↑ outranks the popup, so it works even while completion is open.
- Escape during a streaming turn aborts and resets the chord. The branch picker needs an empty composer and a stopped turn, or `/tree` and `/branch`.
- While a dialog is open, its capture-phase Escape closes the dialog and never reaches the composer, so Escape cannot abort a turn while a dialog is up.
- The onboarding session picker intercepts Escape for New session before the dialog's own close handler, so the picker cannot be dismissed with Escape during onboarding.
- Ctrl+O is the only application-wide key that still acts while a dialog is open, and only when focus is not in a text field.
- Inside the transcript, arrow and Page keys are taken over even when a nested control has focus; Home, End, and Shift+Space are the ones that step aside.

## Errors and no-ops

- Keyboard actions use the same code path as their buttons, so failures are reported the same way: send, queue, abort, and queue-pop failures land in the status bar banner, and login-code failures land in the dialog notice.
- Ignored keys raise nothing: Enter while the session is not ready, Escape with no turn streaming, Alt+↑ with an empty queue, and Ctrl+O with nothing to expand all do nothing visible.
- A page reload caused by an unguarded browser key is not an application error. The session keeps running on its session daemon and the transcript stays intact.

## Common tasks

| Task | Keys |
| --- | --- |
| Send a prompt or steer a running turn | Enter |
| Queue a follow-up | Ctrl+Enter or Cmd+Enter |
| Pop the last queued message, edit it, and resend | Alt+↑, then Enter |
| Abort a streaming turn | Escape |
| Open the branch picker on an empty composer | Escape, Escape |
| Search prompt history | Ctrl+R, then ↑ or ↓, then Enter |
| Expand all tool output | Ctrl+O |
| Close any dialog or menu | Escape |

## Related

- [Prompting the agent](/sessions/prompting/) explains the composer, completion, queues, history, and agent dialogs in context.
- [Interface tour](/getting-started/interface-tour/) names the surfaces these keys act on.
- [The fleet sidebar](/fleet/sidebar/) describes the rows and menus that open the roster dialogs.
- [Browse historical transcripts](/analysis/transcripts/) covers the Analysis tabs and tool table.
