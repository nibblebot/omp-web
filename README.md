# omp-session + omp-fleet

**omp-session** is a single-session agent daemon for [`@oh-my-pi/pi-coding-agent`](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent): one process, one project directory (bound at spawn, immutable), one live agent session, served to a Solid.js web UI over WebSocket. The agent runs in-process via the SDK (`createAgentSession`) — there is no child process and no JSON-RPC hop. It builds as a self-contained binary (`bun run build:omp-session`) — no repo checkout, no node_modules on the target.

**omp-fleet** holds the registry of N sessions — local children it spawns and supervises, externally launched sessions it attaches to, and remote sandboxes it dials into — and re-exposes them to the same web UI (roster mode) and to non-interactive drivers (CLI fan-out). It holds zero SDK state; all agent truth lives in the omp-session processes and their `.jsonl` session logs.

```
browser (Solid, one app, two modes)
   ⇄ WS  ⇄ omp-session (standalone: full single-session UI)
   ⇄ WS  ⇄ omp-fleet (roster mode) ⇄ per-browser proxied WS ⇄ omp-session …
                                      ⇄ control WS ⇄ omp-session …  (remote: ssh -L / tailnet / direct)
```

## Quickstart

Prerequisite: [Bun](https://bun.sh). Then `bun install` once.

### Dev mode — standalone omp-session (single-session UI)

```sh
bun run dev:server   # terminal 1: omp-session on :4721, --watch reload
bun run dev:web      # terminal 2: vite on :4713 (proxies /ws + /download → 4721)
```

Open <http://localhost:4713>. UI edits hot-reload; server edits restart the daemon.

### Dev mode — omp-fleet (roster UI)

```sh
bun run build                        # one-time (and after UI edits): roster mode serves dist/ from disk
bun run fleet -- serve               # terminal 1: omp-fleet on :4722
bun run dev:server                   # terminal 2: an omp-session to attach (or spawn from the UI instead)
```

Open <http://localhost:4722>, click a `ready` row to attach. Two ways to get a session into the roster:

- **Sidebar spawn** — the default `local` template runs `omp-session …`, so it needs the binary on PATH: `bun run build:omp-session` and add `dist-bin/` to PATH (or edit the template in `~/.omp/fleet/config.json` to launch from the checkout).
- **Attach the dev server** — `bun run fleet -- add dev ws://127.0.0.1:4721 --cwd "$PWD"` (loopback, no token needed; `--cwd` must match the dev server's working directory).

For UI work, keep vite on :4713 for single-session HMR and use :4722 for roster checks — the vite proxy targets omp-session only.

### Production build

```sh
bun run build:omp-session             # → dist-bin/omp-session: self-contained binary, UI embedded
./dist-bin/omp-session --cwd ~/repos/my-project            # listen on 127.0.0.1:4721
./dist-bin/omp-session --cwd . --port 0 --token "$(openssl rand -hex 16)"   # ephemeral port; token required once you bind off-loopback via --host
```

No repo checkout or node_modules needed on the target — copy the binary and run. omp-fleet has no compiled binary yet; run it from a checkout (`bun run build && bun run fleet -- serve`).

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

Env-only collab knobs: `OMP_SESSION_COLLAB_MAX_GUESTS` (default 64), `OMP_SESSION_COLLAB_HOSTNAME`, `OMP_SESSION_COLLAB_URL` (public URL base for join links).

Immediately after bind — before session creation — omp-session prints a contract line on **stdout** (logs go to stderr), so a spawner learns the endpoint early:

```
OMP_SESSION|{"event":"listening","bind":"127.0.0.1","port":4721,"url":"ws://127.0.0.1:4721"}
```

Readiness: after the SDK session exists and provider/model/auth resolution completes, omp-session broadcasts `ready` and stamps `readyAt` into `state`; before that, prompt-family calls fail with a `not_ready` error. Idle exit: with no attached clients, no running agent/queue, no in-flight bash/eval, no open dialog, and no live collab room, omp-session shuts down cleanly after the idle timeout — the `.jsonl` is already durable, and omp-fleet marks the entry `asleep` and respawns it on demand.

## Security model

- Remote sessions are **dial-in only**: omp-fleet initiates every connection; omp-session never dials out and has no `--fleet` flag. A sandbox image contains zero knowledge of the external world (no fleet URL, no outbound credentials), and egress may be denied entirely.
- The bearer token inside a sandbox gates inbound connections to that omp-session only — a leaked token grants nothing beyond it. Loopback peers are exempt; off-loopback requires the token (`Authorization` header, `?token=`, or a first-frame `hello`; failures close with WS code 4001) and a secure transport (ssh `-L`, tailnet, or your own TLS).
- omp-fleet's UI binds loopback. For local children the token travels in the spawn environment — visible in `/proc/<pid>/environ`; accepted for the single-operator v1.
- `/download` stays realpath-jailed to the bound cwd + tmpdir + session dirs; it is the only file-egress path. `list_files` never escapes the cwd.

## omp-fleet

Registry + WS clients + proxy + fan-out. Config `~/.omp/fleet/config.json`, state `~/.omp/fleet/state.json` (remote entries persist `endpoint + token + labels`; spawned entries persist template + cwd + last session file, so the roster survives a fleet restart).

```sh
bun run fleet -- serve                          # foreground; UI + control API on 127.0.0.1:4722
bun run fleet -- sessions                       # roster table
bun run fleet -- projects                       # discovered projects (roots + git worktrees)
bun run fleet -- spawn <path> [--template t] [--name n] [--label k=v]…
bun run fleet -- add <name> <url> --token <t> [--label k=v]… [--cwd c]   # register an external/remote omp-session
bun run fleet -- provision <name> [--label k=v]…  # run the spawn hook (sandbox provisioning)
bun run fleet -- stop <selector>
bun run fleet -- prompt <selector> <text> [--wait <ms>] [--fan-out]
```

Selectors: `dN`, `all`, name glob (`api-*`), `label:k=v` (alias `tag:k=v`), `project:name`. `prompt --wait` correlates on each target session's `agent_end` event and collects the final assistant text + usage per session.

The connector dials each session's resolved endpoint with exponential backoff, runs the `hello`/`hello_ok` handshake (`OMP_PROTO` version gate), verifies `hello_ok.cwd` matches the registry entry (mismatch → `error`, guards stale endpoints and IP reuse), and keeps liveness with ping/pong; a dropped session shows `reconnecting` and proxied browser clients re-attach on return.

### Spawn templates

Sessions are spawned from **command templates** — omp-fleet never hardcodes a launch method. `{cwd}` `{token}` `{name}` `{labels}` `{resume}` are substituted; the child's stdout is parsed for `OMP_SESSION|` contract lines; endpoint resolution order: wrapper `endpoint` line › template-declared `host` + listening port › `advertise` › loopback. Default local template:

```jsonc
// ~/.omp/fleet/config.json
{
	"roots": ["~/repos"],              // project discovery roots (one level deep, git repos + worktrees)
	"defaultTemplate": "local",
	"templates": {
		"local": { "command": "omp-session --cwd {cwd} --port 0 --token {token} --name {name} {labels} {resume}" },
		"vm":    { "command": "ssh vm omp-session --cwd {cwd} --port 4721 --host 0.0.0.0 --token {token} --name {name} {labels} {resume}", "host": "vm" }
	},
	"projectTemplates": { "my-project": "vm" },   // optional per-project override
	"spawnHook": "~/.omp/fleet/provision.sh" // optional; or OMP_FLEET_SPAWN_HOOK
}
```

Copy-pasteable examples live in `fleet/examples/` (`ssh-remote.json`, `docker.json` + `docker-omp-session.sh` wrapper, `provider-skeleton.sh` provision hook). The spawn hook is any script that creates a sandbox and prints `{ "name", "url", "token" }` JSON as its last stdout line; `provision <name>` runs it and registers the result.

Local children are restarted `on-failure` with bounded backoff; the stderr ring buffer is surfaced in the session detail popover.

## The web UI (one app, two modes)

- **Standalone** (served by an omp-session): the full single-session UI — chat, steering, queue chips, live bash/python streaming, rich tool cards, subagent roster + drill-down, settings panel (TUI `/settings` parity), OAuth login, collab rooms (`omp join` TUI guests), session resume/branch/fork/handoff, `/btw` side questions, `/export` HTML transcripts. Composer stays disabled until the daemon's `ready` frame.
- **Roster** (served by omp-fleet): the roster sidebar replaces the sessions sidebar — status dots (`spawning`/`ready`/`asleep`/`reconnecting`/`error`), spawn picker (projects + worktrees + freeform path + template + labels), wake-on-click for asleep sessions, stop with confirm, per-session detail popover (cwd, uptime, labels, last session, stderr tail). Attaching proxies the browser through to that omp-session (`daemonId` at the edge); everything else about the UI is identical.

Collab from the CLI (standalone omp-session):

```sh
bun run collab            # start the collab room, print write + view links
bun run collab -- --join  # …and open the TUI immediately
bun run collab -- --stop
```

## Develop

```sh
bun install
bun run dev:server      # omp-session on :4721 (single-session)
bun run dev:web         # vite dev server on :4713 (proxies /ws + /download → 4721, /ctl → 4722)
bun run fleet -- serve  # omp-fleet on :4722
```

Production: `bun run build:omp-session` → self-contained `dist-bin/omp-session` (UI embedded). Checks: `bun run check:types`, `bun test`.

## Architecture

- `server/index.ts` — the omp-session daemon: one in-process SDK session, the 71-method dispatch table (`WebMethodName`), post-mutation state broadcast with `READ_ONLY`/`HISTORY_RELOAD` resync semantics, builtin slash interception (`executeAcpBuiltinSlashCommand`), full `AgentSessionEvent` forwarding, `ui_request`/`ui_response` dialog relay, settings model + side effects, OAuth login frames, bash/python/ephemeral chunk streaming, subagent lifecycle/progress mirror + steer/abort, collab host adapter + relay, `/download` jail, static UI serving, bearer auth, readiness gate, idle auto-exit.
- `server/config.ts` — flag/env parsing into the config surface above.
- `fleet/` — registry + JSON persistence (`registry.ts`), project discovery (`discovery.ts`), spawn templates + `OMP_SESSION|` parsing (`spawn-parse.ts`, `supervisor.ts`), dial-in connector with hello handshake, cwd sanity check, backoff and ping/pong liveness (`connector.ts`), selectors + fan-out correlation (`selectors.ts`, `fanout.ts`), loopback control API + CLI (`server.ts`, `cli.ts`), browser edge + per-browser session proxy + aggregated sessions panel (`edge.ts`, `daemons-aggregator.ts`).
- `src/protocol.ts` — the shared wire contract: client commands, server frames, the `OMP_SESSION|` line, `hello`/`hello_ok`/`ready`, roster frames. Additive changes only; `OMP_PROTO` (currently 1) gates omp-fleet↔omp-session drift and must bump on any breaking change to the handshake or frame shapes.
- `src/state.ts` — client store: chat items, streaming, session state mirror, `call()` helper, reconnect with backoff, roster state, stale-frame guard (guards session switches).

## Non-goals

- **Concurrent in-process sessions.** The multiplexing registry was removed; the old mux commands (`create_session`/`attach`/`detach`/`close_session`/`list_live_sessions`) are rejected as unknown. Multiplexing lives one layer up: N sessions behind omp-fleet.
- **Multi-user omp-fleet, RBAC, audit.** Single operator assumed.
- **Sandbox provisioning** (creating VMs/containers). Only the spawn-hook contract exists here; providers are external.
- **Collab guest protocol changes** (`pi-wire` frames, TUI guests) — untouched.
- **Unix domain sockets.** WS over TCP everywhere; one transport code path.
- **Plugin/marketplace management UI** — config-file/TUI territory.
- **Voice mode (`/live`) and STT** — audio product surface, no web analog planned.

## Roadmap

- **Token rotation** — none in v1; worth a phase if sandboxes are long-lived.
- **First-class `wss://`** — per-daemon self-signed cert + fingerprint pinning, if ssh `-L` and tailnet stop covering the remote cases. Today omp-session ships with zero TLS code; off-loopback goes through ssh/tailnet or your own TLS termination.
- **omp-fleet packaging** — today it runs from a checkout via `bun run fleet`; a compiled binary like `build:omp-session` is future work.
- **Registry persistence** — JSON state file today; SQLite only if the registry gains history.
- **Deferred TUI surfaces** — session DAG tree view (`/tree`), extension dashboard, MCP/SSH management wizards, `/security` scan UI, `/stats` dashboard embed, `/tan`/`/omfg` panels, first-run setup wizard, LaTeX math rendering. Deferred in the parity sweep, not excluded.
