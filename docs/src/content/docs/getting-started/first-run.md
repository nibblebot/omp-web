---
title: First run
description: Start the omp-web fleet for the first time, answer the data home prompt, and open the fleet UI at the local URL it prints.
---

`omp-web` is the fleet: it hosts the browser UI, the registry of projects, and the supervisor that starts session daemons. The first run in an interactive terminal offers to configure a data home and reports whether the `omp` stack is ready. This page covers that flow, where the files land, and what the browser shows before any project exists.

## Start the fleet

Run `omp-web` with no arguments:

```sh
omp-web
```

A bare `omp-web` is equivalent to `omp-web serve`. The fleet runs in the foreground and serves the browser UI on the same port, with `4722` as the default. Stop it with Ctrl+C when you are done.

To use a different port, name the `serve` command and pass the flag:

```sh
omp-web serve --port 8080
```

Serve options are only parsed with the named command, so `omp-web --port 8080` prints usage instead of starting anything.

## The first-run setup offer

The offer appears only when both conditions hold:

- No config file exists at the resolved location (`~/.omp-web/config.json` by default, moved by `OMP_FLEET_CONFIG`).
- Standard input is a terminal (TTY).

A non-interactive launch, such as from a script or a process manager, skips the probe and the prompt and starts with defaults, so it never blocks.

When the offer runs, `omp-web` first probes the `omp` stack and prints three status lines:

- `omp: installed (<path>)` when the `omp` CLI is found on `PATH` or at `~/.bun/bin/omp`, otherwise `omp: NOT installed` followed by the install command to run.
- `providers: <names>` listing the providers with usable credentials, or `providers: none configured`.
- `default model: <selector>` for the default model role, or `default model: none`.

If any of the three is missing, the probe adds:

```text
first configure omp: run `omp` and set up a provider + default model in its /settings
(or `omp login` for an OAuth provider). omp-web serves anyway, but prompts fail
until a model resolves.
```

The probe is advisory. `omp-web` starts either way, and only prompts fail until a model resolves. If the check itself cannot complete, it prints `omp probe error: <message>`. See [Troubleshooting](/operations/troubleshooting/) for setup problems the probe reports.

### Choose a data home

After the probe, `omp-web` asks once:

```text
No omp-web config found. Data home directory [~/.omp-web]:
```

- Press Enter, or answer `y` or `yes`, to accept the default `~/.omp-web`.
- Answer `n` or `no` to skip setup. `omp-web` serves with defaults and writes no config file, so the next interactive launch offers setup again.
- Any other answer is used as the data-home path. A leading `~` expands to your home directory.

Accepting the prompt creates the data home and its workspaces directory, writes `<data-home>/config.json` with the absolute workspace directory, and prints:

```text
setup: data home configured at <path>
setup: config written to <path>
```

The fleet then boots against that config. If you pass `--workspace-dir <dir>` to the same `serve` command, that directory is used and persisted as the workspace root instead of `<data-home>/workspaces`.

### Where files live

After setup, the fleet keeps its configuration, registry state, and managed worktrees under the selected data home:

| Path | Contents |
| --- | --- |
| `<data-home>/config.json` | Fleet configuration. The first-run offer is its only writer, and it stores the workspace directory. |
| `<data-home>/fleet-state.json` | Roster and registered projects, written next to the config file when the fleet records state. |
| `<data-home>/workspaces/` | Root for managed worktrees. |

The same directory also holds `logs/`, the fleet log store that mirrors session transcripts from managed daemons, and, once browser auth is enabled, `browser-auth.json`. [Data and state management](/configuration/data-and-state/) covers both.

The installed CLI code is separate from the data home. The installer keeps the code in its own pinned prefix (`~/.omp-web/install/` by default) and, by default, links the `omp-web` command from `~/.bun/bin`. The data home holds fleet data only. Choosing a custom data home does not move or reinstall the code, and `omp-web update` updates the code in place. With the default answer the two share `~/.omp-web`, but the `install/` subdirectory belongs to the installer, not to your data.

### The startup banner

Once the fleet is running it prints its banner:

```text
fleet listening on 127.0.0.1:4722
fleet restored 0 sessions
Web UI: http://localhost:4722
```

The lines between them report the resolved state path and the config path, or `fleet config: (defaults)` when you declined setup. On later runs the restored line counts the session daemons recovered from the state file and names their statuses. Open the printed `Web UI` URL in a browser.

## What you should see

The UI starts with an empty fleet: no projects, no session daemons, and no sessions.

- The main area shows `No active session` and `Pick a daemon from the sidebar to start a session.`
- If setup wrote a config file, the sidebar shows the `Projects` header with a button labeled `Add a project`, plus a hint that tells you to press `+` to add one.
- If no config file was written (you answered `n` or `no`, or the launch was not interactive), the sidebar shows the welcome panel instead: `Welcome to omp-web`, an `Add your first project` button, a note that sessions appear once a project exists, and a reminder that running `omp-web` in a terminal offers to configure the data home on first run.

Either way, the next step is adding a project.

## Next steps

- [Add your first project](/getting-started/add-first-project/) registers a Git repository and its main checkout.
- [Start your first session](/getting-started/start-first-session/) starts a session daemon in the main checkout and sends the first prompt.

## If the fleet does not start

- `omp: NOT installed`: install the CLI with `bun install -g @oh-my-pi/pi-coding-agent`, then run `omp` to set it up. `omp-web` still serves, but prompts fail.
- `providers: none configured` or `default model: none`: run `omp` and configure a provider and a default model in its `/settings`, or run `omp login` for an OAuth provider.
- Another fleet already holds the data home: the message names the running process and the locked state path, and the command exits with code 77. Stop the other fleet before starting a new one.
- Anything else: see [Troubleshooting](/operations/troubleshooting/).
