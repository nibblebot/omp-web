> **⚠️ Pre-alpha.** This is personal infrastructure with sharp edges: expect breaking protocol changes, rough UI corners, and the occasional wedged daemon. It is provided **as-is, with no warranty of any kind** — don't run it on anything you can't afford to restart, and don't expose it to a network you don't trust.

# omp-web

**omp-session** is a single-session agent daemon for [`@oh-my-pi/pi-coding-agent`](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent): one process, one project directory (bound at spawn, immutable), one live agent session, served to a Solid.js web UI over SSE + POST commands. The agent runs in-process via the SDK (`createAgentSession`) — there is no child process and no JSON-RPC hop.

**omp-fleet** holds the registry of N daemons — local children it spawns and supervises, externally launched daemons it attaches to, and remote sandboxes it dials into — and re-exposes them to the same web UI (roster mode) and to non-interactive drivers (CLI fan-out). It holds zero SDK state; all agent truth lives in the omp-session processes and their `.jsonl` session logs.

```
browser (Solid, one app, two modes)
   ⇄ SSE/POST ⇄ omp-session (standalone: full single-session UI)
   ⇄ SSE/POST ⇄ omp-fleet (roster mode) ⇄ per-browser proxied SSE/POST ⇄ omp-session …
                                      ⇄ control SSE/POST ⇄ omp-session …  (remote: ssh -L / tailnet / direct)
```

## Quickstart

Prerequisite: [Bun](https://bun.sh). Then `bun install` once.

> **First run:** the daemon serves the UI immediately, but a prompt needs a
> model provider. Configure one via the settings panel (TUI `/settings`
> parity), an existing `~/.omp/agent` provider/auth config, or the OAuth login
> flow. With no auth and no model cache, every prompt fails with
> `No model selected`.

### Dev mode — omp-fleet (roster UI)

```sh
bun run dev   # vite (HMR; /events + /command + /download proxied to the fleet edge) + omp-fleet
```

Ports are chosen at runtime (backends bind ephemeral ports, vite gets a probe-picked port with retries on collision) and the runner prints the stack summary with the actual URLs — but two `bun run dev` in different worktrees now conflict on the shared default state (the second exits with the lock error): intended, it prevents registry clobbering; separate fleets need a distinct `OMP_FLEET_STATE`/`--port 0` combo. Open the printed UI URL, click a `ready` row to attach. UI edits hot-reload in roster mode too. Sidebar spawns work out of the box: `bun run dev` sets `OMP_FLEET_LOCAL_TEMPLATE` so the default `local` template runs `bun server/index.ts` from the checkout (spawned daemons are not `--watch`ed; restart them to pick up server edits).

### Dev mode — standalone omp-session (single-session UI)

```sh
bun run dev:single   # omp-session (--watch reload) + vite (proxies /events + /command + /download → session)
```

Open the printed UI URL. UI edits hot-reload; server edits restart the daemon. (Need the processes in separate terminals? `bun run dev:server` and `bun run dev:web` still exist — those keep the fixed defaults :4721/:4713.)

Both dev commands serve the UI with HMR on a per-run port; `bun run dev` proxies `/events` + `/command` to the fleet edge (`OMP_DEV_FLEET=1` in `vite.config.ts`), `bun run dev:single` proxies them to the standalone omp-session. To reach the UI from another machine, pass `--host` (optionally with an address) to either command — `bun run dev -- --host` binds vite to `0.0.0.0` while the backends stay loopback (remote browsers reach them through vite's proxies). No auth on the UI — trusted networks only. Accessing via a non-localhost domain (e.g. tailscale) trips vite's host check; add `--allow-hosts` to allow every Host header, or `--allow-hosts myhost.tail1234.ts.net` for an allowlist.

## omp-session

One live session per process. Sequential session *replacement* is preserved (`newSession`, `switchSession`, `branch`, `fork`, `handoff`, `compact`, `retry`, `freshSession`); what doesn't exist is concurrent in-process sessions — that is what omp-fleet is for. Disk-backed `.jsonl` logs make omp-session disposable: respawn with `--resume <file>` and the transcript is back.

### Config surface

Flags map 1:1 to env vars:

| Flag / env | Default | Meaning |
| --- | --- | --- |
| `--cwd` / `OMP_SESSION_CWD` | process cwd | Bound project root (immutable for the process lifetime) |
| `--port` / `OMP_SESSION_PORT` | `4721` | Listen port (`0` = ephemeral; actual bind reported on the `OMP_SESSION\|` line) |
| `--host` / `OMP_SESSION_HOST` | `127.0.0.1` | Bind address; anything else **requires** `--token` (hard error otherwise) |
| `--advertise` / `OMP_SESSION_ADVERTISE` | — | Overrides the address reported on the `OMP_SESSION\|` line (reporting only) |
| `--token` / `OMP_SESSION_TOKEN` | — | Bearer token gating off-loopback peers (loopback exempt) |
| `--resume` / `OMP_SESSION_RESUME` | — | Session file to resume at boot |
| `--idle-timeout` / `OMP_SESSION_IDLE_TIMEOUT` | `30m` | Idle auto-exit (`0` disables); `90s`/`30m`/`1h` suffixes |
| `--name` / `OMP_SESSION_NAME` | cwd basename | Registry display name |
| `--label k=v` / `OMP_SESSION_LABELS` | — | Selector labels (repeatable / comma-separated) |

Immediately after bind — before session creation — omp-session prints a contract line on **stdout** (logs go to stderr), so a spawner learns the endpoint early:

```
OMP_SESSION|{"event":"listening","bind":"127.0.0.1","port":4721,"url":"ws://127.0.0.1:4721"}
```

Readiness: after the SDK session exists and provider/model/auth resolution completes, omp-session broadcasts `ready` and stamps `readyAt` into `state`; before that, prompt-family calls fail with a `not_ready` error. Idle exit: with no attached clients, no running agent/queue, no in-flight bash/eval, no open dialog, and no live collab room, omp-session shuts down cleanly after the idle timeout — the `.jsonl` is already durable, and omp-fleet marks the entry `asleep` and respawns it on demand.

## omp-fleet

Registry + SSE clients + proxy + fan-out. Config `~/.omp/fleet/config.json`, state `~/.ompweb/fleet-state.json` (remote entries persist `endpoint + token + labels`; spawned entries persist template + cwd + last session file; registered projects persist in the same file — the roster survives a fleet restart). Managed worktrees live under `~/.ompweb/workspaces` (flag/env/config-overridable, created lazily on first worktree). The pre-consolidation locations (`~/.ompweb/fleet/state.json`, `~/ompweb/workspaces`) are not read and not migrated — move any data by hand if present.

**State locking:** the fleet takes an exclusive lock on `<state file>.lock` for its lifetime — a second fleet (or a second `bun run dev`) fails fast with `fleet already running (pid N) — state locked at <path>` instead of clobbering state; an omp-session takes an exclusive lock on `<sessionFile>.lock` for its lifetime — a second daemon resuming the same session file exits with `omp-session: session file <file> is locked by another omp-session (pid N)`. Locks are pidfiles that self-heal: a lock left by a dead process is broken automatically on the next start. The webui is stateless (served by fleet or omp-session), so these two locks cover it.

### Config surface

| Flag / env | Default | Meaning |
| --- | --- | --- |
| `--port` / `OMP_FLEET_PORT` | `4722` | Control-plane port (`0` = ephemeral) |
| `--workspace-dir` / `OMP_FLEET_WORKSPACE_DIR` | `~/.ompweb/workspaces` | Root for managed worktrees (created on first worktree, not at boot) |
| `OMP_FLEET_STATE` | `~/.ompweb/fleet-state.json` | Registry state file (env only) |
| `OMP_FLEET_CONFIG` | `~/.omp/fleet/config.json` | Config file (env only; explicit path wins) |
| `OMP_FLEET_SPAWN_HOOK` | — | Provision-hook command (env only; wins over the config file) |
| `OMP_FLEET_LOCAL_TEMPLATE` | — | Replaces the `local` spawn-template command (dev runners) |

```sh
bun run fleet -- serve                          # foreground; UI + control API on 127.0.0.1:4722
bun run fleet -- sessions                       # roster table
bun run fleet -- projects                       # discovered projects (roots + git worktrees)
bun run fleet -- spawn <path> [--template t] [--name n] [--label k=v]…
bun run fleet -- add <name> <url> --token <t> [--label k=v]… [--cwd c]   # register an external/remote omp-session
bun run fleet -- provision <name> [--label k=v]…  # run the spawn hook (sandbox provisioning)
bun run fleet -- stop <selector>
bun run fleet -- remove <selector>                    # remove from the roster (stops it first)
bun run fleet -- add-repo <path> [--start] [--template t] [--labels k=v,...]   # register a project (deduped on realpath)
bun run fleet -- rm-project <selector>                # deregister a project (refused while daemons reference it)
bun run fleet -- add-worktree <project> <name> [--base ref] [--branch existing] [--no-start]   # create + register a managed worktree
bun run fleet -- add-worktree <project> --existing <path> [--no-start]   # register a discovered-but-unregistered worktree
bun run fleet -- rm-worktree <daemon-id> [--delete-branch]   # stop + evict + git worktree remove
bun run fleet -- prompt <selector> <text> [--wait <ms>] [--fan-out]
```

Selectors: `dN`, `all`, name glob (`api-*`), `label:k=v` (alias `tag:k=v`), `project:name`. `prompt --wait` correlates on each target session's `agent_end` event and collects the final assistant text + usage per session.

The connector dials each daemon's resolved endpoint over HTTP with exponential backoff and bearer-token auth (loopback exempt), verifies `hello_ok.cwd` from the SSE priming matches the registry entry (mismatch → `error`, guards stale endpoints and IP reuse; `OMP_PROTO`, currently 2, gates drift), and keeps liveness with the SSE silence deadline; a dropped daemon shows `reconnecting` and proxied browser clients re-attach on return.

Local children are restarted `on-failure` with bounded backoff; the stderr ring buffer is surfaced in the daemon detail popover.

### Projects and managed worktrees

Fleet has first-class **registered projects** (realpath-keyed, `pN` ids, persisted in the state file). Everything hangs off them:

- **Add a repo** — the sidebar header **+** (or `fleet add-repo`). Pick a path from the discovery list or type one; the retired spawn picker's template/labels fields live in the collapsed advanced section. **Start a session now** defaults **off**; when on, the main checkout is spawned and attached, and the session picker opens if the checkout has session history (new-vs-resume).
- **Add a worktree** — the per-project **+ Add worktree** (or `fleet add-worktree`), two tabs: **Create new** (a name; the branch is the slugified name off `origin/HEAD` → local default branch → current `HEAD` — no fetch; the advanced section overrides the base ref or attaches an existing branch) and **Add existing** (discovered-but-unregistered linked worktrees of the project). **Start a session now** defaults **on**. Managed worktrees land at `<workspaceDir>/<repo>/<name>/` (a repo-basename collision gets a short hash suffix).
- **Session picker** — a newly added worktree with history on disk opens the picker after attach: "New session" top item, most-recent-first with the newest pre-highlighted, **Esc = new session**; no history → straight into a fresh session, no modal. Routine wake of an asleep row stays silent (`--resume`).

**Close-out ladder** — stop any daemon → remove it from the roster (disk untouched) → **Delete worktree…** on managed worktree rows → remove the project. Delete-worktree semantics: the path must be under `workspaceDir` (we never delete a directory we didn't create); a **dirty** worktree is **refused** (no `--force` in v1 — commit or stash first); the confirm dialog shows the dirty counts and the branch's merged/unpushed state, with "Also delete branch" defaulting on when merged and pushed — the branch delete is `git branch -d` only, never `-D`. Session transcripts always survive: they live under the agent dir, never inside the worktree. **Remove project** refuses while any daemon still references it (it names the blockers: stop/remove them first) and never touches disk.

## The web UI (one app, two modes)

- **Standalone** (served by an omp-session): the full single-session UI — chat, steering, queue chips, live bash/python streaming, rich tool cards, subagent roster + drill-down, settings panel (TUI `/settings` parity), OAuth login, session resume/branch/fork/handoff, `/btw` side questions, `/export` HTML transcripts. Composer stays disabled until the daemon's `ready` frame.
- **Roster** (served by omp-fleet): the roster sidebar replaces the standalone single-session layout — standalone has no sidebar; session switching there is a modal via `/resume`. The sidebar is **project-first**: each registered project is a collapsible group with the main-checkout row first, then worktree rows (branch icon + branch name, never the dir/path), a per-project **+ Add worktree** action and a remove-project action; entries without a registered project (remote/unregistered) fall back to repo string-grouping in one trailing group. The header **+** opens the add-repo modal (the retired spawn picker's template/labels fields live in its advanced section). Rows show branch + git dirty counts (`+N ~M -D ?U`, polled from local cwds), status dots (`spawning`/`ready`/`asleep`/`reconnecting`/`error`), bare-icon attach/stop/remove actions (stop/remove are two-click confirms) and **Delete worktree…** on managed worktree rows, wake-on-click for asleep daemons, and a per-daemon detail popover (cwd, uptime, labels, last session file, stderr tail). Attaching proxies the browser through to that omp-session (`daemonId` at the edge); everything else about the UI is identical.

### Historical transcripts view (◫ Tx, roster mode)

A read-only browser/analytics surface over all historical omp sessions, folded in from the standalone `session-viewer` app. The status-bar **◫ Tx** toggle (roster mode only) switches the main pane to a session list + detail view: per-session **Analytics** (tool breakdown, latency p50/p90, tokens/cost, error turns, live-vs-db provenance), a virtualized **Transcript** with tool-call pairing, day separators, tool filtering and subagent drill-in, and a **Sync stats DB** action. Data comes from `~/.omp/stats.db` (metrics; `omp stats --summary` refreshes it) and `~/.omp/agent/sessions/**/*.jsonl` (transcripts), served read-only by the fleet control plane under `/ctl/stats/*` — server `fleet/stats/`, wire contracts `shared/stats-types.ts`, client `src/tx/`. Fixture-based stats tests regenerate with `bun run tx-fixture`.

## Develop

```sh
bun install
bun run dev           # roster: vite (HMR, /events + /command → fleet edge) + omp-fleet — ports chosen per-run
bun run dev:single    # single-session: omp-session (--watch) + vite (HMR) — ports chosen per-run
# or separately: bun run dev:server / dev:web / fleet -- serve  (fixed defaults :4721 / :4713 / :4722)
```

Only the dev path is supported. Checks: `bun run check:types`, `bun test`.

## Architecture

Layering is strictly leaf-ward: `server/` and `fleet/` import only from `shared/`, `src/` imports neither backend layer, and `server/` and `fleet/` never import each other. See [`docs/architecture.md`](docs/architecture.md) for the full treatment (wire contract, lifecycle, security model, state ownership).

- `server/` — the omp-session daemon: `index.ts` (boot, routing, auth, `/download` jail, idle auto-exit, static UI), `methods.ts` (`WebMethodName` dispatch table), `sse-delivery.ts` (ring, broadcast, backpressure), `ui-context.ts` (dialog relay), `subagent-mirror.ts` (subagent lifecycle/progress + transcripts), `daemon-broker.ts` (hub ActiveDaemons panel), `settings-model.ts`, `session-entry.ts`, `config.ts`, `collab-*.ts` (host adapter + relay).
- `fleet/` — registry + JSON persistence (`registry.ts`), project discovery (`discovery.ts`), managed-worktree lifecycle (`worktrees.ts`), spawn templates + `OMP_SESSION|` parsing (`spawn-parse.ts`, `supervisor.ts`), dial-in SSE client with hello priming, cwd sanity check, backoff and silence-deadline liveness (`connector.ts`), selectors + fan-out correlation (`selectors.ts`, `fanout.ts`), loopback control API + CLI (`server.ts`, `cli.ts`), browser edge + per-browser daemon proxy + aggregated daemons panel (`edge.ts`, `daemons-aggregator.ts`).
- `shared/protocol.ts` — the shared wire contract: client commands (`POST /command`), server frames (`GET /events` SSE), the `OMP_SESSION|` line, the `hello_ok`→`attached`→`history`→`state`→`collab_status`→`available_commands`→`ready` priming sequence, roster frames. Additive changes only; `OMP_PROTO` (currently 2) gates omp-fleet↔omp-session drift and must bump on any breaking change to the handshake or frame shapes.
- `src/state.ts` — client store: chat items, streaming, session state mirror, `call()` helper, reconnect with backoff, roster state, stale-frame guard (guards session switches).

## Non-goals

- **Concurrent in-process sessions.** The multiplexing registry was removed; the old mux commands (`create_session`/`attach`/`detach`/`close_session`/`list_live_sessions`) are rejected as unknown. Multiplexing lives one layer up: N sessions behind omp-fleet.
- **Multi-user omp-fleet, RBAC, audit.** Single operator assumed.
- **Sandbox provisioning** (creating VMs/containers). Only the spawn-hook contract exists here; providers are external.
- **Plugin/marketplace management UI** — config-file/TUI territory.
- **Voice mode (`/live`) and STT** — audio product surface, no web analog planned.

## Roadmap

Strategic positioning (moat, differentiators, open product items): [`docs/position.md`](docs/position.md).

- **Packaging** — everything runs from a checkout today; a compiled binary is future work.
- **Deferred TUI surfaces** — session DAG tree view (`/tree`), extension dashboard, MCP/SSH management wizards, `/security` scan UI, `/stats` dashboard embed, `/tan`/`/omfg` panels, first-run setup wizard, LaTeX math rendering. Deferred in the parity sweep, not excluded.
