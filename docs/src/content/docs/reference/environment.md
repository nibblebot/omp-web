---
title: Environment variables
description: Canonical reference for the environment variables that the fleet, session daemons, agent runtime, and installer read, including defaults, precedence, and error behavior.
---

omp-web reads environment variables in several separate processes: the fleet (fleet mode), each session daemon, the embedded Oh My Pi agent runtime inside those session daemons, and the install and update commands. This page is the canonical list. Each section names the owning process, the runtime modes it applies to, the accepted shape, and the exact precedence chain.

Rules that hold everywhere:

- Precedence is resolved per setting, not globally: explicit flag, then the matching environment variable, then a config-file value, then the built-in default. A setting with no flag or no config key skips that tier; each section lists the exact chain.
- Values are read once when a process starts. Restart the fleet, or the affected session daemon, after changing a variable.
- Session daemons started by the fleet inherit the fleet process environment, because spawn templates run through `sh -c` without an environment override. Where you set a variable decides who sees it.
- The browser UI has no environment variables. Browser preferences are stored locally per browser; see [Configuration](/configuration/).

## Fleet

Applies to fleet mode: the `omp-web` process that prints the startup banner, serves the browser UI, owns the loopback control plane, and spawns session daemons. The other fleet commands (`sessions`, `spawn`, `stop`, `prompt`, and so on) are loopback clients of that control plane and resolve the same port variable.

| Variable | Default | Effect |
| --- | --- | --- |
| `OMP_FLEET_CONFIG` | `~/.omp-web/config.json` | Path of the fleet config file. The config chosen by the first-run offer overrides it for that process. An empty value counts as unset, and a missing file loads defaults instead of failing. A leading `~` expands to the home directory. |
| `OMP_FLEET_STATE` | `<config dir>/fleet-state.json` | Registry file that holds the roster and the registered projects. The default lives next to the resolved config file, so the first-run data home moves config, state, and managed worktrees together. A leading `~` expands. |
| `OMP_FLEET_PORT` | `4722` | Control plane port, bound on loopback. Accepts 0 through 65535, where `0` picks an ephemeral port that the startup banner reports. An invalid value stops the command with `invalid OMP_FLEET_PORT: <value>` and exit code 1. |
| `OMP_FLEET_WORKSPACE_DIR` | `~/.omp-web/workspaces` | Root directory for managed worktrees. The directory is created on demand: the first-run offer creates the one it records in the config, and `omp-web` creates it lazily when the first managed worktree is added. A leading `~` expands. |
| `OMP_FLEET_SPAWN_HOOK` | none | Provider provision command run by `omp-web provision`. See [Spawn hook contract](#spawn-hook-contract). |
| `OMP_FLEET_LOCAL_TEMPLATE` | built-in `local` template | Replaces the `local` spawn template command outright, in every process that loads fleet configuration. The development runners use it to spawn session daemons from source when no production bundle is built. |

Exact precedence per setting:

- Worktree root: `--workspace-dir` flag, then `OMP_FLEET_WORKSPACE_DIR`, then the config-file `workspaceDir` key, then `~/.omp-web/workspaces`.
- Control plane port: `--port` flag, then `OMP_FLEET_PORT`, then `4722`.
- Config file: explicit path (the data home chosen at first run), then `OMP_FLEET_CONFIG`, then `~/.omp-web/config.json`.
- State file: `OMP_FLEET_STATE`, then `<config dir>/fleet-state.json`.
- Spawn hook: `OMP_FLEET_SPAWN_HOOK`, then the config-file `spawnHook` key, then none.
- Local template: `OMP_FLEET_LOCAL_TEMPLATE`, then the config-file `templates.local.command` entry. The variable is applied after the file is loaded, so it wins even when the file sets a local template.

For every fleet variable, an empty string is treated as unset. Config loading is lenient: an unreadable or corrupt file falls back to defaults, and unknown keys are tolerated. The first-run offer in `omp-web serve` is the only writer of the config file.

The state file is pidfile locked for the lifetime of the fleet. Starting a second fleet against the same state file exits with code 77 and reports `fleet already running (pid <pid>)` plus the lock path. See [First run](/getting-started/first-run/) and [Troubleshooting](/operations/troubleshooting/).

### Spawn hook contract

`omp-web provision <name>` runs the hook from `OMP_FLEET_SPAWN_HOOK` or the config-file `spawnHook` key through `sh -c` with a 60 second deadline. The hook receives two variables describing the request:

| Variable | Value |
| --- | --- |
| `OMP_HOOK_NAME` | Requested session daemon name. May be empty. |
| `OMP_HOOK_LABELS` | Comma-joined `k=v` labels. May be empty. |

The last non-empty stdout line must be a JSON object with a `url` (a `ws://` or `wss://` address) and a `token`, and may also carry `name` and `cwd`. Diagnostics belong on stderr. A non-zero exit, a timeout, or unparsable output fails the command with HTTP 502; calling `provision` with no hook configured fails with HTTP 400. The result is registered as a remote session daemon, so the fleet connects to it (dial-in) rather than the other way around. See [Remote and advanced](/advanced/) for provider integration.

## Session daemon

Applies to both runtime modes: a standalone session daemon started with `omp-web session`, and a session daemon spawned by the fleet. Each knob has a matching flag, and the flag wins over the variable.

| Variable | Flag | Default | Effect |
| --- | --- | --- | --- |
| `OMP_SESSION_CWD` | `--cwd` | current directory | Project directory bound to the session daemon for its lifetime. The binding is immutable; file access and the served UI are scoped to it. |
| `OMP_SESSION_PORT` | `--port` | `4721` | Listen port. `0` binds an ephemeral port, and the real port is reported on stdout in the `OMP_SESSION\|` line. |
| `OMP_SESSION_HOST` | `--host` | `127.0.0.1` | Bind address. A non-loopback bind without a token is a startup error. |
| `OMP_SESSION_IDLE_TIMEOUT` | `--idle-timeout` | `30m` | Idle auto-exit timeout. `0` disables it. Accepts a bare number of milliseconds, or a `ms`, `s`, `m`, or `h` suffix (`90s`, `30m`, `1h`). |
| `OMP_SESSION_TOKEN` | `--token` | none | Bearer token. Off-loopback peers must present it as `Authorization: Bearer <token>` or `?token=<token>`; a missing or wrong credential gets a 401. Required for non-loopback binds. |
| `OMP_SESSION_ADVERTISE` | `--advertise` | none | Alternate reachable address, reported as the `advertise` field of the `OMP_SESSION\|` listening line. Must be a `ws://` or `wss://` URL. It does not change the bind; a spawner uses it when its template names no host and no wrapper endpoint line appears. |
| `OMP_SESSION_RESUME` | `--resume` | none | Session file to resume at boot. A failure warns on stderr and starts a fresh session instead. |
| `OMP_SESSION_NAME` | `--name` | basename of `--cwd` | Display name, used in the fleet roster and in the identity frame the session daemon sends on connect. |
| `OMP_SESSION_LABELS` | `--label` (repeatable) | none | Selector labels as a comma-separated `k=v` list. Values from the variable are appended after any `--label` flags, so both can contribute. |
| `OMP_SESSION_COLLAB_MAX_GUESTS` | none | `64` | Guest cap per collaboration room. |
| `OMP_SESSION_COLLAB_MAX_ROOMS` | none | `256` (floor 1) | Live and orphaned room cap for the session daemon's collaboration relay. A host upgrade for a new room past the cap is refused. |
| `OMP_SESSION_COLLAB_HOSTNAME` | none | operating system user name, or `web` | Host display name reported in collaboration status. |
| `OMP_SESSION_COLLAB_URL` | none | `ws://localhost:<port>` | Relay address advertised in the join links the session daemon reports. The host socket always connects to the local relay over loopback, so a public URL here never needs a token and never hairpins through the network. |

**Precedence and empty values.** For every row, the flag wins over the variable and the variable wins over the built-in default. Unlike the fleet variables, an empty session variable is not treated as unset: an empty `OMP_SESSION_PORT` parses as `0` (an ephemeral port), and an empty `OMP_SESSION_IDLE_TIMEOUT` is an invalid duration. Remove the variable from the environment to get the default.

**Fleet-spawned session daemons.** The built-in `local` template runs:

```sh
omp-web session --cwd {cwd} --port 0 --token {token} --name {name} {labels} {resume}
```

Because flags win over environment variables, `OMP_SESSION_CWD`, `OMP_SESSION_PORT`, `OMP_SESSION_TOKEN`, `OMP_SESSION_NAME`, and `OMP_SESSION_RESUME` set in the fleet environment do not affect fleet-spawned session daemons; the fleet supplies those values for each spawn. Variables the template does not pass, such as `OMP_SESSION_IDLE_TIMEOUT` and the collaboration caps, are inherited from the fleet process. A custom template decides exactly which flags reach the child, and anything it omits falls back to the inherited environment.

**Startup errors.** Config parsing runs before the session daemon binds. An invalid port, an invalid duration, or an unparsable flag stops the process with `omp-session: <message>` on stderr and exit code 1:

```text
$ omp-web session --port 70000
omp-session: Error: invalid port "70000" (0-65535; 0 = ephemeral)
```

A non-loopback bind without a token refuses to start even earlier:

```text
$ OMP_SESSION_HOST=0.0.0.0 omp-web session
omp-session: refusing to bind non-loopback address "0.0.0.0" without a token; pass --token or set OMP_SESSION_TOKEN
```

A `--resume` target owned by another session daemon fails the transcript lock check with exit code 1 and names the holder. See [Operate session daemons from the CLI](/cli/session-daemon-operations/) and [Troubleshooting](/operations/troubleshooting/) for the remote and recovery paths.

Collaboration rooms are hosted and joined through the CLI or TUI; omp-web has no browser collaboration surface. The three `OMP_SESSION_COLLAB_*` caps exist to bound the relay that the session daemon hosts, not to add a browser feature.

## Agent runtime and session transcripts

These variables configure the embedded Oh My Pi agent runtime. Session daemons load that runtime in process, so each session daemon's environment is the runtime's environment. In fleet mode, the statistics surfaces read the same names from the fleet process at boot.

| Variable | Default | Effect |
| --- | --- | --- |
| `PI_CODING_AGENT_DIR` | `~/.omp/agent` | Agent directory. Session transcripts live in `<dir>/sessions`, and the runtime resolves its authentication storage and settings from the same directory. The fleet reads it from its own environment when it lists a worktree's sessions, and the Analysis views read it as their sessions root. |
| `PI_CONFIG_DIR` | `~/.omp` | Oh My Pi config root. The statistics database resolves to `<PI_CONFIG_DIR>/stats.db` when the variable is set, otherwise to `~/.omp/stats.db`. The `omp` CLI treats the value as a home-relative directory name, while the omp-web statistics viewer treats it as a literal path; the statistics sync reconciles the two when it spawns `omp`. |
| `XDG_DATA_HOME` | unset | Fallback used by the Analysis views when `PI_CODING_AGENT_DIR` is unset: transcripts are looked up under `$XDG_DATA_HOME/omp/agent/sessions`. Without it, the fallback is `<config root>/agent/sessions`. |
| `PI_PROFILE` | unset | Oh My Pi profile name. Session daemons inherit it from the process that starts them. The statistics sync removes it from the `omp` child whenever it derives the config root, so the child cannot resolve a different database than the viewer. |
| `PI_NO_TITLE` | unset | When set to any non-empty value, the session daemon does not generate a session title from the first prompt. |

The session daemon resolves the agent directory from its own environment at startup, and the fleet lists sessions from its environment when the roster dropdown opens. For the session picker and the Analysis views to agree with a running session daemon, both processes must see the same agent directory. The default local spawn template inherits the fleet environment, so this agreement is automatic unless a custom template points a session daemon somewhere else.

Transcripts are durable and live outside worktrees, so changing the agent directory after sessions exist points future work at a different history. See [Projects, worktrees, session daemons, and sessions](/concepts/projects-worktrees-session-daemons-sessions/) for the ownership model.

The statistics sync also derives its child environment from the resolved locations: it always sets `PI_CODING_AGENT_DIR` to the absolute sessions parent, for the default `~/.omp/stats.db` it drops any inherited `PI_CONFIG_DIR` and `PI_PROFILE` so `omp` falls back to its own default target, for a database elsewhere under the home directory it passes the home-relative directory name as `PI_CONFIG_DIR` and drops `PI_PROFILE`, and for a database outside the home directory it refuses, because an absolute `PI_CONFIG_DIR` cannot address it. Keep `stats.db` under the home directory, or leave `PI_CONFIG_DIR` unset. See [Analysis and usage](/analysis/).

## Install and update

These apply to the distribution commands. `omp-web update` reinstalls the pinned bundle and inherits the environment, so a redirected `BUN_INSTALL` reaches the child `bun` process.

| Variable | Default | Effect |
| --- | --- | --- |
| `BUN_INSTALL` | `~/.bun` | Root that owns the `bin` directory. The installer links `omp-web` into `$BUN_INSTALL/bin`, and `omp-web update` honors the same location when it reinstalls. |
| `OMP_WEB_UPDATE_URL` | `https://github.com/nibblebot/omp-web/releases/latest/download` | Base URL of the update channel. `omp-web update` fetches `<base>/release-manifest.json`, downloads the tarball the manifest names, and verifies its SHA-256 before installing. With `--version x.y.z`, a `latest/download` base is rewritten to `download/v<x.y.z>`, and any other base gets `/download/v<x.y.z>` appended. |

```sh
OMP_WEB_UPDATE_URL=https://releases.example.test/omp-web omp-web update --check
```

Installation layout, verification, and the update workflow itself are covered in [Installation](/getting-started/installation/).

## Contributor and test-only variables

Everything below is internal to development, tests, and release tooling. It is listed so contributors do not have to search the source, and it is not part of the supported user configuration surface.

| Variable | Used by | Effect |
| --- | --- | --- |
| `OMP_DEV_FLEET` | `vite.config.ts` | `1` makes the development web server proxy `/events`, `/command`, and `/download` to the fleet edge instead of a standalone session daemon. |
| `OMP_DEV_FLEET_PORT` | `vite.config.ts` | Fleet edge port for the development proxy. Default `4722`. |
| `OMP_DEV_SESSION_PORT` | `vite.config.ts` | Standalone session daemon port for the development proxy. Default `4721`. |
| `OMP_DEV_ALLOW_HOSTS` | `vite.config.ts` | `1`, `true`, or `*` allows every Host header; anything else is a comma-separated allowlist. Set by `bun scripts/dev.ts --allow-hosts`. |
| `OMP_SESSION_TEST_READY_DELAY_MS` | session daemon tests | Delays the readiness gate by the given number of milliseconds after provider, model, and authentication resolution completes. |
| `OMP_SESSION_TEST_IDLE_CHECK_MS` | session daemon tests | Idle auto-exit check interval in milliseconds. Default `15000`. |
| `OMP_SESSION_TEST_UI_REQUEST` | session daemon tests | `1` accepts the `test_ui_request` command, which creates a dialog request without a model turn. |
| `PI_MAX_JSONL_BYTES` | statistics tests | Byte cap used when parsing oversized transcript files; overrides the 256 MiB default at call time. |
| `OMP_WEB_INSTALLER_API` | offline installer test | Redirects the GitHub API calls made by `scripts/install.sh`. |
| `OMP_WEB_DOWNLOAD_BASE` | offline installer test | Redirects the release asset downloads made by `scripts/install.sh`. |
| `OMP_WEB_INSTALL_DIR` | offline installer test | Redirects the install directory used by `scripts/install.sh`. |
| `OMP_WEB_RELEASE_PROFILE` | release tooling | Oh My Pi profile passed to the changelog summarization turns in `scripts/release-llm.ts`. |

The contributor collaboration CLI (`bun run collab`, `bun server/collab-cli.ts`) defaults its session daemon port from `OMP_SESSION_PORT`, the same variable the session daemon itself reads for its listen port.
