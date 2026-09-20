---
title: Goals and plan mode
description: Drive long-running work with goal mode, draft plans without touching the working tree in plan mode, and know what each mode changes and what it persists.
---

Two session modes change how the agent works over time. Goal mode gives the session an objective to keep pursuing across turns. Plan mode makes the working tree read-only while the agent drafts an execution plan. Both are session state, not browser preferences, so they apply to the attached session wherever it runs.

## Goal mode

A goal is a persistent objective with optional token accounting. Once a goal is active, the session keeps working on it instead of stopping at the end of a turn.

### Set a goal

Use `/goal set <objective>`, or open the goal panel with `/goal` and type the objective into the field, then choose `set`. Only one goal can be active at a time; while a goal exists the panel offers pause, resume, and drop instead of the create form, and creating a second goal is refused.

### Read the state

- The status bar shows a `goal:` badge with the start of the objective. Click it to open the goal panel.
- The panel shows the objective, its status, the elapsed time, and, when the goal carries a token budget, a progress bar with tokens used against the budget.
- Goal statuses are `active`, `paused`, `budget-limited`, `complete`, and `dropped`. When the goal is not active, the panel also shows the mode and its reason.

The badge and panel update live as the goal changes, including when the agent updates it.

### Control a goal

| Control | Effect |
| --- | --- |
| `pause` | Suspends the objective so the session stops continuing it. |
| `resume` | Puts a paused goal back to active. |
| `drop` | Abandons the goal. The work already done in the transcript stays. |

Completion is the agent's call. The goal tooling instructs the agent to audit the current repository state against every deliverable before it marks a goal complete, and to leave the goal active when the work is unfinished rather than treating an exhausted budget as success. You can always drop a goal you no longer want.

### What goal mode changes

- While a goal is active, the session sends the agent hidden continuation prompts instead of letting the turn be the end of the work. Those continuations are not separate user messages and do not appear as your turns in the transcript.
- The goal is recorded in the session as a mode change entry, so the objective travels with the session file and is visible in the [transcript browser](/analysis/transcripts/).
- Pausing, dropping, or completing a goal ends the autonomous continuation.

## Plan mode

Plan mode is for deciding what to do before doing it. It is available from the browser and applies to the attached session.

### Enter and leave

- `/plan` toggles plan mode.
- The `plan` badge in the status bar appears while plan mode is active; clicking it toggles the mode too.

The change applies from the next turn. Plan mode is not persisted as a session mode the way a goal is; a fresh session starts without it.

### While plan mode is active

- The working tree is read-only. The agent's `write` and `edit` tools reject changes to files in the working tree with an error that points the agent at a session-local plan file instead. Renaming and deleting files are rejected as well.
- The agent can still read, search, and use session-local `local://` artifacts, which is where it drafts the plan. Plan files are markdown named for the task, typically `local://<slug>-plan.md`.
- The mode's instructions also forbid state-changing commands such as commits or package installs, so the agent explores and reasons instead of executing.
- The session expects each planning turn to converge on a decision. A turn must end with a question back to you, which arrives as an agent dialog, or with a plan proposal. If the agent just stops, the session appends a reminder and continues the turn, up to a small limit.

### Approving a plan in the browser

The approval surface that follows a plan proposal is wired by the terminal and ACP hosts. omp-session does not install that handler, so a proposal write in a browser session fails as a tool error and no execution-mode picker appears.

To move from planning to execution in the browser, leave plan mode with `/plan` and ask the agent to implement the plan. Full tool access returns immediately, and the plan file stays in the session's local artifacts for the agent to follow. If you want the proposal and approval flow itself, use the terminal agent; see the [CLI overview](/cli/overview/) for the terminal surfaces.

## Scope and settings

- Goal mode and plan mode both belong to the attached session. With no session attached, there is no session for them to apply to.
- The enable toggles for both modes live in Settings under Tasks, in the Modes group: Goal Mode and Plan Mode.

## Failure cases

- `/goal set` with no objective opens the panel instead of creating a goal, and the panel's `set` button stays disabled until the field has text.
- Creating a goal while one is active is refused, matching the terminal behavior. Drop the current goal first.
- In plan mode, a write to a working-tree file fails with the read-only error. This is expected; the plan belongs in a `local://` artifact.
- A plan proposal in the browser fails as described above. Leave plan mode to implement.

## Related

- [Prompting the agent](/sessions/prompting/)
- [Models, roles, and thinking levels](/sessions/models-roles-thinking/)
- [Manage session history](/sessions/history/)
- [Session persistence](/concepts/session-persistence/)
- [Transcripts](/analysis/transcripts/)
- [Slash commands](/reference/slash-commands/)
