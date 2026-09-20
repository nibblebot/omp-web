---
title: Settings overview
description: How the omp-web settings panel is organized, which changes belong to the browser, the session, the agent configuration, and the fleet, and where each change is saved.
---

The Settings panel is the browser counterpart of the Oh My Pi `/settings` screen in the `omp` terminal UI. It renders the same schema, so items and labels match the terminal experience. What differs is ownership: some controls change only this browser, some command the attached session, some persist into the agent configuration files, and some belong to the fleet's own configuration. Treating the panel as one settings store leads to wrong expectations about when a change takes effect and where it is saved.

## Ownership at a glance

| Owner | Settings | Persistence |
| --- | --- | --- |
| Browser-local | Theme, font size, desktop notifications, sidebar visibility, usage panel, Work or Analysis view, collapsed roster groups, prompt history. | Browser storage for the site origin, per browser. See [Web interface preferences](/configuration/web-preferences/). |
| Session-scoped | Thinking level, fast mode, auto-retry, reveal queue, soft fade, steering, follow-up, and interrupt modes. | The live session daemon or the browser session; nothing is persisted, so a restart or reload returns the defaults. |
| Agent configuration | The schema-backed settings and model roles. | `config.yml` in the agent directory, with the project `.omp/config.yml` layer for model roles. See [Models and provider authentication](/configuration/models-and-auth/). |
| Fleet configuration | Spawn templates, the default and per-project templates, the spawn hook, and the managed worktree root. | The omp-web config file. See [Configure spawn templates](/configuration/spawn-templates/). |
| Persistent data | Fleet registry state, session transcripts, the statistics database, and the browser preference store. | Files under the data home and the Oh My Pi agent directories. See [Data and state management](/configuration/data-and-state/). |

## Opening the panel

Two entry points open it:

- The Settings segment in the status bar.
- The gear button in the fleet sidebar footer (fleet mode).

The panel opens as a full-screen sheet with a search box, a section list, and the section body.

## Sections

The panel always shows a **Web UI** section first, then one section per Oh My Pi schema tab that has a web home: Model, Interaction, Context, Memory, Files, Shell, Tools, Tasks, and Providers.

| Section | What it holds | Ownership |
| --- | --- | --- |
| Web UI | Theme, font size, desktop notifications, usage in sidebar, reveal queue, soft fade, the Images group (`images.*`), and, while a session is attached, fast mode, auto-retry, and the Login providers button. | Mixed; the panel groups browser-local, session-scoped, and schema-backed items here on purpose. See [Web interface preferences](/configuration/web-preferences/). |
| Model, Interaction, Context, Memory, Files, Shell, Tools, Tasks, Providers | The schema-backed agent settings, grouped exactly as in the TUI. | Agent configuration files. Model roles covered in [Models and provider authentication](/configuration/models-and-auth/). |

The Appearance tab exists in the Oh My Pi schema, but the web panel does not render it. Its Images group is folded into Web UI; the rest of Appearance remains TUI-only and is not shown in the browser.

Items can be conditionally hidden: a settings item whose schema condition does not hold is not rendered, and a group left with no items disappears from its section. For example, the provider in-flight limits row lists only the providers that currently have models available.

## Layout and search

- On wide layouts (721px and up) the left rail lists sections and, for the active section, its subsections. Selecting a subsection scopes the body to that group. On narrow layouts the rail is replaced by a section picker, and the full body of the section is rendered.
- The search box filters instead of navigating. Matching is case-insensitive and covers each item's label, description, group name, and setting path. Results are grouped by section, and only the `images.*` items participate from the Appearance tab.
- Switching sections clears the search and the subsection choice.
- Rows show the current value, and a row whose value differs from the schema default carries a marker dot. Two compaction thresholds display `default` when they are unset (stored as the schema's sentinel value), and an ordered multiselect displays `default` when nothing is selected.

## How changes are saved

The panel has two save paths, chosen by whether the browser is attached to a session daemon.

**With a session attached** (single-session mode, or fleet mode with an attached row), rows call the session's settings RPCs. The session daemon coerces the value against the schema, applies it to the live session, persists it, and returns a fresh settings model, which becomes the panel's source of truth. Live side effects run where a setting has one: steering and follow-up modes, interrupt mode, the advisor toggle, the default thinking level, personality, memory backend, sampling values, image inspection mode, and provider search ordering all take effect in the running session immediately. Every other attached browser tab stays in sync because the session daemon broadcasts a `settings_changed` frame.

**With no session attached** (fleet mode only), the panel is served by the fleet's own settings service. Edits are still validated against the schema and persisted, but no live session receives side effects, because there is none. The panel says so: changes save to `config.yml` and apply to new sessions. The next session daemon a project starts picks the values up when it boots.

A session daemon resolves its settings from the agent configuration files, not from the browser:

- Global layer: `<agent dir>/config.yml`, which is `~/.omp/agent/config.yml` by default.
- Project layer: `<session working directory>/.omp/config.yml`, written only for model roles, and overrides the global layer for that directory.
- Runtime overrides: session actions such as the live thinking level, fast mode, or auto-retry apply to the running process and are not persisted; they reset when the session daemon restarts.

The panel never writes into the fleet configuration file (`~/.omp-web/config.json`) or into browser storage for schema-backed items. Those files and stores are covered in [Data and state management](/configuration/data-and-state/).

## Precedence by domain

There is no single precedence order across the panel. Each domain resolves its own sources:

| Domain | Resolution |
| --- | --- |
| Session daemon flags | Each `--flag` maps 1:1 to an `OMP_SESSION_*` environment variable. For a given option, the flag wins, then the environment variable, then the built-in default. |
| Agent settings | Global `config.yml`, then the project `.omp/config.yml` overrides it, then non-persisted runtime overrides. Model role assignments follow the configured role storage scope. |
| Fleet configuration | Config file: `OMP_FLEET_CONFIG`, then `~/.omp-web/config.json`. Managed worktree root: `--workspace-dir`, then `OMP_FLEET_WORKSPACE_DIR`, then the config key, then the default. Spawn hook: `OMP_FLEET_SPAWN_HOOK` beats the file. See [Configure spawn templates](/configuration/spawn-templates/). |
| Browser preferences | A single browser store, so there is no precedence chain; unset values use defaults, and first-run defaults can depend on the viewport. See [Web interface preferences](/configuration/web-preferences/). |

The complete environment-variable and precedence inventory lives in the [environment reference](/reference/environment/), and the configuration file schema lives in the [configuration reference](/reference/configuration/).

## Failure states

- `Settings unavailable.` means no settings model could be loaded: the session RPC failed, or the fleet's settings route answered an error. The error is shown in the status line; reopening the panel retries the load.
- An invalid value rejects the edit. The session daemon returns a message for uncoercible or unknown values, the row keeps its previous value, and the error surfaces in the status line.
- Closing the panel while a change is in flight is safe. The request continues, and the next model refresh reflects the result.
- Editing while unattached never fails because of a missing session; it is a supported path on the fleet. It just cannot touch a live conversation.

## Related

- [Models and provider authentication](/configuration/models-and-auth/)
- [Web interface preferences](/configuration/web-preferences/)
- [Data and state management](/configuration/data-and-state/)
- [Configure spawn templates](/configuration/spawn-templates/)
- [Troubleshooting](/operations/troubleshooting/)
