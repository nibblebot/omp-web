> **⚠️ Pre-alpha.** Personal infrastructure with sharp edges: expect breaking changes, rough UI corners, and the occasional wedged daemon. Provided **as-is, no warranty** — don't run it on anything you can't afford to restart, and don't expose it to a network you don't trust.

# omp-web

omp-web is a **web UI and session fleet for [`@oh-my-pi/pi-coding-agent`](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent)** — one installed command, one browser UI, N agent sessions.

- **One entrypoint.** `omp-web` starts the fleet (registry + supervisor + UI server); `omp-web session` runs a single agent daemon; the same binary dispatches the fleet control verbs and self-update.
- **Sessions run as separate processes** (one project directory each, bound at spawn). A daemon hosts one live agent session in-process via the SDK — no child-process JSON-RPC hop — and serves the UI over SSE + POST commands.
- **The fleet holds zero agent state.** It registers/restarts daemons, proxies the browser to them, and persists only roster metadata; all agent truth lives in the daemon processes and their `.jsonl` session logs.
- **Projects, not repos.** There is no discovery scanning and no default repos directory — every project is added by picking a directory in the UI.

```
browser (Solid.js)
   ⇄ SSE/POST ⇄ omp-web (fleet: roster UI, registry, supervisor, edge)
                          ⇄ proxied SSE/POST ⇄ omp-web session (agent daemon) …
```

## Requirements

- [Bun](https://bun.sh) (the runtime and the installer)
- the **`omp` CLI** with at least one provider and a default model configured — run `omp` and set it up in its `/settings` (or `omp login` for an OAuth provider). omp-web verifies this on first run and prompts fail until a model resolves.

## Install

Build the installable bundle, pack a tarball, and install it into omp-web's
own pinned directory. The bundle is a single minified JS file
(`#!/usr/bin/env bun`); the `@oh-my-pi/*` packages stay external and are
installed at their **exact pinned versions** next to the bundle.

```sh
git clone <this-repo> && cd omp-web
bun install

bun run install:omp-web       # builds (bun run build) → packs (bun pm pack) → installs
omp-web --version             # verify: prints <version>
```

The one-liner builds the installable bundle (`bun run build` → `dist-bundle/cli.js`,
vite UI + version-stamped bundle), packs it (`bun pm pack` →
`omp-web-<version>.tgz`, just `dist-bundle/` + `package.json`/`README`), and
installs it. Prefer a specific tarball? `bun run install:omp-web -- ./omp-web-0.1.0.tgz`.
Install the code somewhere else? `bun run install:omp-web -- --prefix /opt/omp-web`
(the data home is still chosen at first run, independently). The default
`~/.omp-web` needs no flag — it follows the machine's own convention of one
dotdir per tool (`~/.bun`, `~/.omp`), with the code under `install/` and the
data beside it.

**Why not `bun install -g`?** The global bun store is a flat `node_modules`
shared with the `omp` CLI, so it can hold only **one** version of each
`@oh-my-pi/*` package — bun keeps whatever `omp` has installed and the
version-skewed bundle crashes at runtime (missing exports). The installer
instead runs `bun add` in `~/.omp-web/install/` — a dedicated project dir with
its own `node_modules` pinned to the tarball's exact SDK versions — then links
`~/.bun/bin/omp-web` to the bundle. The `omp` CLI and its SDK versions are
untouched. Uninstall: `bun remove -g omp-web` is handled by the installer's
cleanup; remove the `~/.omp-web/install` dir and the bin symlink to fully
uninstall.

> A release tarball from the GitHub channel installs the same way:
> `bun scripts/install-omp-web.ts ./omp-web-<version>.tgz`. Nothing is
> published to any npm registry today.

### Self-update

```sh
omp-web update                # check the release channel and reinstall the latest
omp-web update --check        # just report the newest version
omp-web update --version x.y.z   # pin a specific release
```

Update fetches a `release-manifest.json` (`{version, tarball, sha256}`),
verifies the tarball's sha256, and reinstalls it in the pinned directory
(`bun remove omp-web` + `bun add` — a same-name path-tarball re-add alone
trips bun's dependency-loop check). The release channel is GitHub Releases
once the repo exists; `OMP_WEB_UPDATE_URL` overrides the base for local
fixtures.

### Offline verification

`bun scripts/test-onboard.ts` runs the whole distribution walk locally — pack → sandboxed global install → first-run config → serve → spawn → update round-trip — with no network beyond the dependency registry, and cleans up after itself (exit 0 = green).

## First run

On a terminal with no `~/.omp-web/config.json`, `omp-web`:

1. **Checks the omp stack** — `omp` installed, ≥1 provider with usable auth, a default model selected (read through the SDK itself). Missing pieces print the standard method: run `omp`, configure a provider + default model in `/settings`, or `omp login`.
2. **Prompts for the data home** — `No omp-web config found. Data home directory [~/.omp-web]: ` — Enter accepts the default, or type an alternate (`~/…` for the home dir); it creates the data + workspaces dirs and writes `~/.omp-web/config.json` (workspaceDir only). `n` declines and serves with defaults.
3. **Serves** — banner on stdout line 1, UI on `http://localhost:4722`.

Non-interactive runs skip the offer and serve with defaults. Projects and worktrees are added afterwards from the UI's directory picker.

## Usage

`omp-web` with no arguments is `omp-web serve`. Control verbs talk to the running fleet over its loopback API.

```sh
omp-web                              # start the fleet: registry + supervisor + UI
omp-web session [options]            # run a single-session agent daemon
omp-web sessions | projects          # roster / registered projects
omp-web spawn <path>                 # start a daemon on a directory
omp-web add-repo <path> [--start]    # register a project (deduped on realpath)
omp-web add-worktree <project> <name> [--no-start]      # create a managed worktree
omp-web add-worktree <project> --existing <path>        # adopt an existing one
omp-web stop <selector> | remove <selector>
omp-web rm-project <selector> | rm-worktree <daemon-id> [--delete-branch]
omp-web prompt <selector> <text> [--wait <ms>] [--fan-out]
omp-web update [--check] [--force] [--version x.y.z]
```

Selectors: `dN`, `all`, name glob (`api-*`), `label:k=v`, `project:name`.

### What lives where

- `~/.omp-web/` — the default data home: `config.json` (defaults, written only by the first-run offer), `fleet-state.json` (roster + registered projects, atomic writes, exclusive pidfile lock), `workspaces/` (managed worktrees, created lazily). The data home is chosen at first run (`Data home directory [~/.omp-web]: ` — any path, `~/` expands); config, state, and workspaces always live together under it.
- `<prefix>/install/` — the CLI code (default `~/.omp-web/install/`): the `bun add` project whose `node_modules` pins the `@oh-my-pi/*` versions. Independent of the data home — `bun run install:omp-web -- --prefix /opt/omp-web` puts the code there while the data home stays a first-run choice.
- `~/.omp/` — the omp SDK's own config (`~/.omp/agent`), owned by the omp TUI; omp-web never writes there.
- Session transcripts live under the agent dir, never inside a worktree, so worktree deletion never touches them.

Fleet env overrides: `OMP_FLEET_PORT` (default 4722), `OMP_FLEET_STATE`, `OMP_FLEET_CONFIG`, `OMP_FLEET_WORKSPACE_DIR`, `OMP_FLEET_LOCAL_TEMPLATE` (dev). Daemon flags (`--cwd`, `--port`, `--host`, `--token`, `--resume`, `--idle-timeout`, …) map 1:1 to `OMP_SESSION_*` env vars.

### Behavior worth knowing

- **State locking.** One fleet per state file (a second `omp-web` exits 77); one daemon per session file (exit 1). Locks are pidfiles that self-heal after crashes.
- **Idle auto-exit.** Daemons shut down after 30m idle (no clients, no running agent); the fleet marks them `asleep` and respawns them on demand with `--resume`.
- **Health.** Daemons are restarted on-failure with bounded backoff; a dropped connection shows `reconnecting` and browsers re-attach on return. `OMP_PROTO` (2) gates fleet↔daemon drift.
- **Managed worktrees** can only be git-removed by omp-web if they live under `~/.omp-web/workspaces` and are clean — no `--force`, branch delete is `git branch -d` only. Adopted external worktrees are evict-only.

## The web UI

One Solid.js app, served by the fleet in **roster mode** (the sidebar: project-first groups, worktree rows, git dirty counts, a directory picker for adding projects, first-run panel) or directly by a single daemon in **standalone mode** (full single-session UI with no sidebar). Attaching a roster row proxies the browser through to that daemon; everything else is the same UI — chat, streaming tool cards, subagents, settings (TUI `/settings` parity), OAuth login, session resume/branch/fork/handoff, transcripts.

## Develop

```sh
bun install
bun run dev           # roster mode: vite (HMR) + fleet — ports chosen per run
bun run dev:single    # standalone: daemon (--watch) + vite — ports chosen per run
bun run dev:server    # just the daemon (--watch); bun run dev:web = just vite
bun run check:types   # tsgo (NOT tsc)
bun run lint          # oxlint (warnings don't fail)
bun run format        # oxfmt (TS/TSX only)
bun run test          # full suite; add a file filter: bun scripts/test.ts <file>
bun scripts/test-onboard.ts   # offline distribution E2E (install → serve → spawn → update)
```

Dev spawns are wired to the checkout via `OMP_FLEET_LOCAL_TEMPLATE` — no build needed for day-to-day work. Two `bun run dev` in different worktrees conflict on the shared state lock by design; separate fleets need a distinct `OMP_FLEET_STATE`.

## Architecture

Layering is strictly leaf-ward: `server/` (the daemon) and `fleet/` (registry, supervisor, connector, edge, control API) import only from `shared/`; `src/` (the UI) imports neither backend layer. See [`docs/architecture.md`](docs/architecture.md) for the full treatment (wire contract, lifecycle, security model, state ownership) and [`docs/position.md`](docs/position.md) for strategy.

## Non-goals

- **Concurrent in-process sessions** — N sessions means N daemons; the old mux commands are rejected as unknown.
- **Multi-user / RBAC / audit** — single operator.
- **Sandbox provisioning** — the spawn-hook contract only; providers are external.
- **Plugin/marketplace management UI** — config-file/TUI territory.
- **Voice mode (`/live`)** — no web analog planned.

## Roadmap

- **Packaging** — install bundle, `bun install -g`, self-update, and the offline E2E are live; the GitHub release channel (`scripts/release.ts`), live-channel update check, and optional npm publish are the remaining pieces. `build:omp-session` (self-contained binary) is retained as a standalone artifact.
- **Deferred TUI surfaces** — session DAG tree view (`/tree`), extension dashboard, MCP/SSH management wizards, `/security` scan UI, `/stats` dashboard embed, `/tan`/`/omfg` panels, LaTeX math rendering.
