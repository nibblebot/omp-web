---
title: CLI overview
description: "Use the installed omp-web command to start the fleet, run one session daemon, and drive the same fleet operations the browser UI exposes."
---

`omp-web` is the installed entrypoint for both the browser experience and the terminal. The verbs in this section operate the same fleet, registry, and session daemons the browser talks to, so a shell script, a CI job, and the fleet sidebar all see one roster.

Two of the commands start long-running processes instead of asking a running fleet to do something: bare `omp-web` (or `omp-web serve`) starts the fleet, and `omp-web session` runs one session daemon on its own. Everything else is a short-lived client request, except `omp-web preflight`, which validates a provider profile in its own process and needs no fleet at all.

## What the CLI talks to

Except for `serve`, `session`, and `preflight`, each command opens a loopback HTTP connection to the running fleet's control plane and exits when the request finishes:

- Default address: `127.0.0.1:4722`.
- `--port <n>` on any fleet verb selects a different port.
- `OMP_FLEET_PORT` sets the default port for the flag.

The fleet binds loopback only, so these commands must run on the same machine as the fleet. If nothing is listening, the command exits 1 with a message that the fleet is not running and a suggestion to start it. There is no queueing and no auto-start: start the fleet first, then run the verb. See [Networking and browser access](/operations/networking/) for exposing the fleet to other machines.

## Commands by job

| Job | Command | In depth |
| --- | --- | --- |
| Start the fleet | `omp-web`, `omp-web serve` | This page |
| List the roster | `omp-web sessions` | [Operate session daemons](/cli/session-daemon-operations/) |
| List adoptable worktrees | `omp-web projects` | [Manage projects and worktrees](/cli/projects-and-worktrees/) |
| List provider profiles | `omp-web profiles` | [Provider profiles](/configuration/provider-profiles/) |
| Validate a provider profile | `omp-web preflight --profile <id>` | [Sandboxed session runtime](/advanced/sandbox-runtimes/) |
| Register a project | `omp-web add-repo <path>` | [Manage projects and worktrees](/cli/projects-and-worktrees/) |
| Deregister a project | `omp-web rm-project <selector>` | [Manage projects and worktrees](/cli/projects-and-worktrees/) |
| Create or adopt a linked worktree | `omp-web add-worktree` | [Manage projects and worktrees](/cli/projects-and-worktrees/) |
| Delete a managed worktree | `omp-web rm-worktree <daemon-id>` | [Manage projects and worktrees](/cli/projects-and-worktrees/) |
| Create a clone workspace | `omp-web add-clone <project> <name> --profile <id>` | [Clone workspaces](/fleet/clone-workspaces/) |
| Start a stopped clone workspace | `omp-web start <daemon-id>` | [Clone workspaces](/fleet/clone-workspaces/) |
| Start a local session daemon | `omp-web spawn <path>` | [Operate session daemons](/cli/session-daemon-operations/) |
| Register a remote session daemon | `omp-web add <name> <url> --token <t>` | [Operate session daemons](/cli/session-daemon-operations/) |
| Start a session daemon through a hook | `omp-web provision <name>` | [Operate session daemons](/cli/session-daemon-operations/) |
| Stop or remove roster entries | `omp-web stop <selector>`, `omp-web remove <selector>` | [Operate session daemons](/cli/session-daemon-operations/) |
| Prompt several session daemons at once | `omp-web prompt <selector> <text>` | [Fan-out prompting](/cli/fanout/) |
| Address a set of session daemons | selectors | [Select multiple session daemons](/cli/selectors/) |
| Run one session daemon | `omp-web session [options]` | [Run a session daemon](/cli/session-daemon/) |
| Print or change the version | `omp-web --version`, `omp-web update` | [Updates](/operations/updates/) |

Every command signature and flag lives in [CLI commands and flags](/reference/cli/).

## Running the fleet

```sh
omp-web                 # same as omp-web serve
omp-web serve --port 4722 --workspace-dir ~/.omp-web/workspaces
```

- `--port <n>` sets the port for the control plane and the web UI together. It defaults to 4722, and `OMP_FLEET_PORT` supplies the default for the flag.
- `--workspace-dir <d>` sets the root for managed worktrees. It defaults to `~/.omp-web/workspaces`, with `OMP_FLEET_WORKSPACE_DIR` and the config file's `workspaceDir` key as fallbacks. The root is created on the first worktree, never at boot. See [Create and adopt worktrees](/fleet/worktrees/).
- `--bind <addr>` sets the address the control plane and the browser edge bind. It defaults to `127.0.0.1`; a non-loopback bind without browser auth configured refuses to start. The matching environment variable is `OMP_FLEET_BIND` and the config key is `bind`. See [Browser access and sign-in](/operations/browser-auth/).
- `--browser-access-token <t>` turns on browser sign-in. The token is stored only as its SHA-256 digest (`OMP_FLEET_BROWSER_TOKEN`, config key `browserAccessToken`), and `--browser-origin <o>` admits one public origin for browser mutations (config key `browserOrigin`). `--trusted-proxy <ip-or-cidr>` is repeatable and names the reverse proxies whose forwarded headers the fleet honors (config key `trustedProxies`).
- First run with no config file on an interactive terminal offers a short setup: it checks the omp stack (installed CLI, provider authentication, default-role model), asks for a data home (default `~/.omp-web`), writes the config there, and boots with it. Declining serves with defaults and writes nothing, and non-interactive runs skip the offer entirely. See [First run](/getting-started/first-run/).
- The startup banner states the address (the first line keeps a stable shape because scripts parse the port out of it), the state file, the config file or the fact that defaults are in use, the restored session count by status, and the web UI address.
- While the fleet runs, it prints one line per lifecycle transition, for example a session daemon reaching a new status. `Ctrl+C` or `SIGTERM` closes the server and exits 0.
- A second fleet over the same state file refuses to start and exits 77, naming the process that holds the lock. The registry is written by one fleet only. See [Data and state management](/configuration/data-and-state/).

## Output and exit codes

| Situation | Behavior |
| --- | --- |
| Success | A table (`sessions`, `projects`) or one line per action, exit 0 |
| Bad flag value or missing flag value | Message on stderr, exit 1. For example `--wait` without a millisecond value. |
| Unrecognized command | The usage summary on stderr, exit 1 |
| Fleet not running | A message that the fleet is not running, exit 1 |
| Control-plane error | `fleet error (<status>): <message>` on stderr, exit 1 |
| `preflight` with any failed check | The per-check lines with their `fix:` remediations, exit 1 |
| `serve` with the state file already locked | A message naming the holder, exit 77 |
| `prompt --wait` with a failing target | The failure text in that target's result block, exit 0 |

A control-plane error covers validation failures, nonexistent paths, unknown selectors, and guard refusals. The message comes from the fleet and names the cause, for example an unregistered project selector or a dirty worktree.

The one asymmetric case is an awaited fan-out: `prompt --wait` exits 0 as soon as it has printed every target's block, so scripts that need failure detection must read the blocks rather than the exit status. [Fan-out prompting](/cli/fanout/) describes the block format.

## What the CLI does not cover

- The fleet verbs require a running fleet. Every verb except `serve`, `session`, and `preflight` is a request to the fleet's control plane, so there is nothing for them to read or change until `omp-web` is running.
- `omp-web session` starts one session daemon: one bound directory, one live session, no registry. It never reads the fleet registry, and it serves no roster surfaces. See [Run a session daemon](/cli/session-daemon/).
- `omp-web preflight` reads the fleet config file and probes this host, so it reports on the machine you run it on, not on a running fleet.
- Analysis views, the fleet sidebar, and project and worktree management are browser surfaces of the fleet-served UI; the CLI reports roster, profile, and discovered worktree rows and applies registration changes.
- Collaboration rooms are operated outside the browser UI; they are not part of these fleet verbs. See [Collaboration rooms](/advanced/collaboration/).

## Related

- [Manage projects and worktrees](/cli/projects-and-worktrees/)
- [Operate session daemons](/cli/session-daemon-operations/)
- [Select multiple session daemons](/cli/selectors/)
- [Fan-out prompting](/cli/fanout/)
- [Run a session daemon](/cli/session-daemon/)
- [CLI commands and flags](/reference/cli/)
