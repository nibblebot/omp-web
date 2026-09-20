---
title: Models, roles, and thinking levels
description: Change the session model through model roles, set the thinking level, and understand where each choice is persisted and when it applies.
---

The session bar above the composer shows the model and thinking level the attached session will use for its next turn. Both are controls: the model segment opens the model roles wizard, and the thinking segment cycles the level or opens a picker on right-click.

The controls apply to the attached session. If no session is attached, there is no session bar to act on.

## The session bar

| Segment | Shows | Interaction |
| --- | --- | --- |
| Model | `provider/model`, or `no model` before a model resolves | Click to open the model roles wizard. |
| Thinking | The current thinking level, or `inherit` when nothing is set | Click to cycle to the next level supported by the model; right-click to pick from the full list. |

The model segment opens the model roles wizard described below, because a session runs on a role assignment, not on a bare model id.

## Model roles

A role is a named slot that supplies a model. The catalog contains the built-in roles (`default`, `smol`, `slow`, `vision`, `plan`, `designer`, `commit`, `tiny`, `task`, `advisor`) plus any custom roles configured for your agent. The `default` role is the session's own model; the other roles are there for the jobs that request them, such as subagents, planning, vision work, and commit messages.

The wizard has three steps:

1. **Roles.** Every visible role is listed with its assigned `provider/model`, a chip showing any thinking level baked into the assignment, or `auto` when nothing is assigned. Each row has `clear` (return the role to auto selection) and `hide`. Hidden roles stay functional but move into a collapsible hidden section, where `unhide` restores them.
2. **Model.** A fuzzy-filterable list of the session's available models, grouped by provider. Rows mark reasoning-capable models and show their context window. The filter is case-insensitive fuzzy matching; Enter picks the first match.
3. **Thinking.** For a model with a controllable reasoning surface, this step picks the thinking level to bake into the role value, starting with `inherit` (defer to the session level) and `off`. Models without a reasoning surface skip this step and are assigned without a level.

Assignments are persisted to a file, and the wizard footer says which one:

- `saves to global config.yml` when Model Role Storage is `global`, the default.
- `saves to project .omp/config.yml` when it is `project`.

Model Role Storage lives in Settings under Model, in the Prompt group. Changing the active role applies it to the live session immediately; changing another role takes effect the next time that role is requested. Clearing a role re-resolves it from the remaining configuration.

## Thinking levels

The thinking segment and its picker offer eight selectors: `inherit`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. `inherit` leaves the choice to the session default, and `off` disables reasoning. Concrete levels are resolved against the active model, so a level the model does not support settles on the nearest supported effort.

Clicking the segment cycles through `off`, `auto`, and the model's supported efforts in order. Models without a reasoning surface have nothing to cycle; the click does not change anything.

The session default itself is the Thinking Level setting in Settings under Model, in the Thinking group. It accepts `auto` or a concrete level, and it applies to new sessions unless a role or the session overrides it. The [configuration reference](/reference/configuration/) owns the full list of settings and defaults.

## Where models come from

See [Models and provider authentication](/configuration/models-and-auth/) for signing providers in, and [Integrate a custom provider](/advanced/custom-provider/) if you run your own endpoint. Providers discovered in the background can take a moment to appear after startup; the wizard waits for an in-flight refresh before it shows the list.

## Failure cases

- `no model` in the session bar, or `No models available` in the wizard, means the session has no usable model. Check provider authentication and your default model configuration.
- Assigning an unknown `provider/model` fails with `Model not found: provider/model`.
- Choosing `auto` as a thinking level inside a role assignment is rejected. `auto` cannot be carried through a saved role value; pick a concrete level or `inherit`, or set the session default to `auto` instead.
- A change to a role that is not the session's active role has no immediate visible effect on the conversation.

## Related

- [Models and provider authentication](/configuration/models-and-auth/)
- [Context, tokens, and cost](/analysis/context-tokens-cost/)
- [Goals and plan mode](/sessions/goals-and-plan/)
- [Compaction, retry, and recovery](/sessions/recovery/)
- [Settings overview](/configuration/settings/)
- [Configuration reference](/reference/configuration/)
