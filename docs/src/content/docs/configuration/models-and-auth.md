---
title: Models and provider authentication
description: Assign models to agent roles, choose where role assignments are saved, and authenticate providers for the sessions omp-web runs.
---

Before a session daemon can accept prompts, the Oh My Pi stack must resolve two things: an authenticated provider and a model for the `default` role. The first-run probe checks both and warns when either is missing; until they resolve, session daemons boot but prompts fail. This page covers the two configuration surfaces behind that requirement: model roles and provider authentication.

For per-session model and thinking controls during a conversation, see [Models, roles, and thinking levels](/sessions/models-roles-thinking/).

## Model roles

Oh My Pi does not store one global model. It stores role assignments, and each role resolves to a concrete model when it is needed. Built-in roles always come first in the picker:

| Role | Tag | Display name |
| --- | --- | --- |
| `default` | DEFAULT | Default |
| `smol` | SMOL | Fast |
| `slow` | SLOW | Thinking |
| `vision` | VISION | Vision |
| `plan` | PLAN | Architect |
| `designer` | DESIGNER | Designer |
| `commit` | COMMIT | Commit |
| `tiny` | TINY | Tiny |
| `task` | TASK | Subtask |
| `advisor` | ADVISOR | Advisor |

Specific features resolve specific roles: plan mode uses `plan`, commit message generation uses `commit` (with `smol` as a fallback), the advisor uses `advisor`, and small classification and title jobs use `tiny` and `smol`. Roles introduced by the Oh My Pi configuration, for example through a custom cycle order or tag metadata, join the catalog after the built-ins.

Roles without an assignment resolve automatically from the models available to the session daemon, and the picker shows them as `auto`. A role can also be assigned a model with a baked-in thinking level, stored as `provider/model:level`; without one, the role inherits the session's thinking configuration.

## Editing roles

Open the roles picker from the model segment of the session bar (it shows the live model, or `no model`). The wizard takes three steps:

1. **Roles.** Every role, assigned or not, with its current `provider/model`, an `auto` marker when unassigned, and a chip when a thinking level is baked in. Each assigned row offers **clear**, which returns the role to `auto`, and every row offers **hide** or **unhide**. Hidden roles stay functional; they are filtered from the list until you expand the hidden section.
2. **Model.** The models available to the session daemon, grouped by provider and fuzzy-filtered as you type (`provider/model` is the match target). Reasoning models show a `reasoning` chip and their context window.
3. **Thinking.** Only for models with a controllable thinking surface. Picking `inherit` stores no level; any other value is baked into the role value. `auto` cannot be baked into a role; pick a concrete level or `inherit`. A model without a thinking surface commits directly from step 2.

Changes apply according to the role:

- Assigning `default` switches the live session to that model immediately.
- Changing the role the session is currently using applies live; changing any other role takes effect the next time that role is used.
- Clearing a role returns it to resolution from the next persisted layer, down to automatic selection.

If a role's model is not in the catalog yet, the assignment waits for the session daemon's background model discovery and only then reports `Model not found`. This matters at cold start, when discovery-backed providers can take a few seconds to populate. When no models are available at all, the roles step shows `No models available`.

## Where role assignments are saved

Roles are saved to one of two layers, selected by the **Model Role Storage** setting in the settings panel (Model section, Prompt group). The roles wizard shows the current target under the list: `saves to global config.yml` or `saves to project .omp/config.yml`.

| Scope | File | Notes |
| --- | --- | --- |
| `global` (default) | `<agent dir>/config.yml`, by default `~/.omp/agent/config.yml` | Applies wherever the same agent directory is used, across all projects. |
| `project` | `<working directory>/.omp/config.yml` | Applies only to sessions running in that directory. Missing project roles fall back to the global assignment. |

The session daemon bound to a worktree reads that worktree's `.omp/config.yml` as its project layer. The `default` role is special: switching it is also a live model switch, and it is persisted to the selected scope like any other role.

Role storage is agent configuration, not omp-web state, so it is shared with the `omp` CLI and survives omp-web updates. On disk locations are listed in [Data and state management](/configuration/data-and-state/); the full schema is in the [configuration reference](/reference/configuration/).

## Provider authentication

Provider credentials live in the Oh My Pi agent directory (`~/.omp/agent` by default, relocated by `PI_CODING_AGENT_DIR`), not in the omp-web data home. They are the same credentials the `omp` CLI uses, so logging in through either surface is visible to the other.

- **OAuth providers** can be logged in from the browser. In the settings panel, open Web UI and click **manage** on the **Login providers…** row. The Login modal lists the OAuth providers and marks the ones already authenticated. Choosing **Login** opens the provider's login page; providers that require a code collect it in the modal, and the flow completes server-side even if you close the panel. When a provider integration is not available on this machine, its Login button is disabled.
- **Everything else** is configured through the `omp` CLI, which is exactly what the first-run probe advises: run `omp` and set up a provider and a default model in its `/settings`, or run `omp login` for an OAuth provider.

The Login modal is a session command, so it requires an attached session. In fleet mode with nothing attached, the Login providers row is hidden along with the other session-scoped controls; attach to a session or use single-session mode to log in.

Two related surfaces are configuration, not credentials:

- The Providers settings section holds behavior settings for the configured providers, for example the maximum number of concurrent in-flight requests per provider.
- Provider usage limits (what your subscription allows right now) are reported per session; see [Provider usage limits](/analysis/provider-usage/).

## Failure states

- `providers: none configured` in the first-run probe, or prompts failing with a not-ready error, means no provider can authenticate. Fix it in `omp`, then restart the session daemon (stop the row and wake it again) so it resolves the new credentials; a running session daemon resolved its provider and model when it booted.
- `default model: none` means the `default` role resolves to nothing. Assign it in the roles picker, or configure a default in `omp`.
- An assignment you cannot see in the picker is probably hidden; expand the hidden roles section. Hiding never unassigns a role.
- A model that disappears from the catalog after an assignment stays named in the role, but the session cannot switch to it; reassign the role from the picker.
- Prompts sent before the session daemon clears its readiness gate fail with a not-ready result instead of queueing. Watch the row reach `ready` before prompting; see [Session daemon lifecycle](/concepts/session-daemon-lifecycle/).

## Related

- [Models, roles, and thinking levels](/sessions/models-roles-thinking/)
- [Settings overview](/configuration/settings/)
- [Data and state management](/configuration/data-and-state/)
- [Provider usage limits](/analysis/provider-usage/)
- [First run](/getting-started/first-run/)
- [Troubleshooting](/operations/troubleshooting/)
