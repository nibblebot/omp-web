# omp-web

omp-web is a **web UI for running multiple oh-my-pi sessions, across all your repos and worktrees**: one installed command, one browser UI, N agent sessions.

Because it drives the agent through the SDK instead of the RPC, omp-web has full daemon and subagent control; RPC-based GUIs don't.

<img id="omp-web-demo" src="docs/screenshots/omp-web-demo.gif" alt="omp-web UI demo" width="800">


> **⚠ Early-stage software.** omp-web is under active development and has sharp edges. Expect breaking changes between releases: the wire protocol, config/state formats, and UI are not yet stable. Session transcripts are durable `.jsonl` files, but the surrounding tooling (fleet state, config, managed worktrees) is still evolving; don't treat this as production data storage yet. Report issues and rough spots as you find them.

## Features

- **Multiple Repos, Multiple Worktrees, Multiple Sessions, one UI.** Start, monitor, and chat with one agent daemon per worktree across every repo.
- **A full web UI, not a terminal wrapper.** Live-streamed responses, rendered markdown and diffs, tool output, slash commands, prompt history and autocomplete, per-session context/usage meters, and a transcripts/stats view.
- **Custom wire protocol for full SDK control.** The SSE + POST contract carries the full SDK surface, including daemon and subagent control the RPC doesn't expose.
- **Manage repos and worktrees from the UI.** Register projects (deduped by realpath), create or adopt managed worktrees, and delete them safely: clean-tree-only, `git branch -d`, no `--force`.
- **CLI for automation.** Spawn, stop, remove, inspect, and fan a prompt out to many daemons from the terminal, the same fleet the browser talks to.
- **Self-updating.** `omp-web update` checks the release channel and reinstalls the latest version in one command.
- **Self-healing.** Idle daemons exit after 30 minutes and are respawned on demand; crashed daemons restart with bounded backoff; dropped connections show `reconnecting` and browsers re-attach automatically.

## Runtime

`omp-web` (bare, or `omp-web serve`) runs the fleet: registry, supervisor, and the web UI it serves on one loopback port, proxying the browser through to whichever session daemon you select. `omp-web session` runs one session daemon (one process, one bound directory, one live agent session, wire API only, no web UI): the fleet spawns these by default with a local template, and you run one by hand on a remote host for the fleet to dial in.

Session daemons are disposable processes; the durable truth is the session `.jsonl` transcript on disk.

## Requirements

- [Bun](https://bun.sh) (the runtime and the installer)
- The **`omp` CLI** with at least one provider and a default model configured: run `omp` and set it up in its `/settings` (or `omp login` for an OAuth provider). omp-web verifies this on first run and prompts fail until a model resolves.

## Install

```sh
# One-liner (bun-only; installs bun >= 1.3.14 if missing):
curl -fsSL https://raw.githubusercontent.com/nibblebot/omp-web/main/scripts/install.sh | sh
```

The installer downloads the latest release tarball, verifies its sha256 against the release manifest, and installs it into a pinned project dir (`~/.omp-web/install/`) with a `~/.bun/bin/omp-web` symlink. Then `omp-web update` keeps it current.

## Verify

```sh
omp-web --version
```

## Documentation

Full user documentation lives under [`docs/src/content/docs/`](docs/src/content/docs/) and builds as a Starlight site (`bun install && bun run dev:docs`).

- [What is omp-web?](docs/src/content/docs/getting-started/overview.md) and [Installation](docs/src/content/docs/getting-started/installation.md): the product model and prerequisites.
- [First run](docs/src/content/docs/getting-started/first-run.md) and [Start your first session](docs/src/content/docs/getting-started/start-first-session.md): from an empty fleet to your first prompt.
- [Core concepts](docs/src/content/docs/concepts/projects-worktrees-session-daemons-sessions.md): projects, worktrees, session daemons, and sessions.
- [Fleet management](docs/src/content/docs/fleet/sidebar.md) and [Analysis](docs/src/content/docs/analysis/transcripts.md): the roster and the historical browser.
- [CLI commands and flags](docs/src/content/docs/reference/cli.md), [Configuration schema](docs/src/content/docs/reference/configuration.md), [Environment variables](docs/src/content/docs/reference/environment.md), and [Files and directories](docs/src/content/docs/reference/files.md): the canonical references.
- [Troubleshooting](docs/src/content/docs/operations/troubleshooting.md) and [Security model](docs/src/content/docs/operations/security.md): failure handling and trust boundaries.
- [System architecture](docs/architecture.md): wire contract, module map, and process boundaries for contributors.

## Develop

```sh
bun install
bun dev      # vite (HMR) + fleet, ports chosen per run
```

In a linked worktree, `bun dev` forks the dev fleet state from the main worktree (copy-once, like a git fork), so the worktree's roster boots with the main worktree's sessions/projects instead of empty; later runs keep the diverged fork. `--state-from <path>` forks from an explicit state file or directory, and `--fresh` skips seeding and starts on a clean state.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the checks before a pull request and [`AGENTS.md`](AGENTS.md) for the full engineering map.

## Manual install

Install from this repo (build → pack → install):

```sh
git clone <this-repo> && cd omp-web
bun install
bun run install:omp-web       # build → pack → install into ~/.omp-web/install/
omp-web --version             # verify: prints <version>
```
