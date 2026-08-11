# ompd + omp-orchestrator

**ompd** is a single-session agent daemon for [`@oh-my-pi/pi-coding-agent`](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent): one process, one project directory (bound at spawn, immutable), one live agent session, served to a Solid.js web UI over WebSocket. The agent runs in-process via the SDK (`createAgentSession`). It ships as a self-contained binary (`bun run build:ompd`) — no repo checkout, no node_modules on the target.

**omp-orchestrator** holds the registry of N daemons — local children it spawns and supervises, externally launched daemons it attaches to, and remote sandboxes it dials into — and re-exposes them to the same web UI (roster mode) and to non-interactive drivers (CLI fan-out). It holds zero SDK state; all agent truth lives in the ompd processes and their `.jsonl` session logs.

```
browser (Solid, one app, two modes)
   ⇄ WS  ⇄ ompd (standalone: today's UI, no sidebar)
   ⇄ WS  ⇄ omp-orchestrator (roster mode) ⇄ per-browser proxied WS ⇄ ompd …
                                             ⇄ control WS ⇄ ompd …  (remote: ssh -L / tailnet / direct)
```

## ompd

One live session per daemon. Sequential session *replacement* is preserved (`newSession`, `switchSession`, `branch`, `fork`, `handoff`, `compact`, `retry`, `freshSession`); what doesn't exist is concurrent in-process sessions — that is what the orchestrator is for. Disk-backed `.jsonl` logs make the daemon disposable: respawn with `--resume <file>` and the transcript is back.

### Config surface

Flags map 1:1 to env vars:

| Flag / env | Default | Meaning |
| --- | --- | --- |
| `--cwd` / `OMPD_CWD` | process cwd | Bound project root (immutable for the process lifetime) |
| `--port` / `OMPD_PORT` | `4721` | Listen port (`0` = ephemeral; actual bind reported on the `OMPD\|` line) |
| `--host` / `OMPD_HOST` | `127.0.0.1` | Bind address; anything else **requires** `--token` (hard error otherwise) |
| `--advertise` / `OMPD_ADVERTISE` | — | Overrides the address reported on the `OMPD\|` line (reporting only) |
| `--token` / `OMPD_TOKEN` | — | Bearer token gating off-loopback peers (loopback exempt) |
| `--resume` / `OMPD_RESUME` | — | Session file to resume at boot |
| `--idle-timeout` / `OMPD_IDLE_TIMEOUT` | `30m` | Idle auto-exit (`0` disables); `90s`/`30m`/`1h` suffixes |
| `--name` / `OMPD_NAME` | cwd basename | Registry display name |
| `--label k=v` / `OMPD_LABELS` | — | Selector labels (repeatable / comma-separated) |

Immediately after bind — before session creation — ompd prints a contract line on **stdout** (logs go to stderr):

```
OMPD|{"event":"listening","bind":"127.0.0.1","port":4721,"url":"ws://127.0.0.1:4721"}
```

Readiness: after the SDK session exists and provider/model/auth resolution completes, ompd broadcasts `ready` and stamps `readyAt` into `state`; before that, prompt-family calls fail with a `not_ready` error. Idle exit: with no attached clients, no running agent/queue, no in-flight bash/eval, no open dialog, and no live collab room, the daemon shuts down cleanly after the idle timeout — the orchestrator marks it `asleep` and respawns on demand.

## omp-orchestrator

Registry + WS clients + proxy + fan-out. Config `~/.omp/orchestrator/config.json`, state `~/.omp/orchestrator/state.json` (remote entries persist `endpoint + token + labels`; spawned entries persist template + cwd + last session file, so the roster survives an orchestrator restart).

```sh
bun run orchestrator -- serve                       # foreground; UI + control API on 127.0.0.1:4722
bun run orchestrator -- daemons                     # roster table
bun run orchestrator -- projects                    # discovered projects (roots + git worktrees)
bun run orchestrator -- spawn <path> [--template t] [--name n] [--label k=v]…
bun run orchestrator -- add <name> <url> --token <t>   # register an externally launched / remote ompd
bun run orchestrator -- provision <name> [--label k=v]… # run the spawn hook (sandbox provisioning)
bun run orchestrator -- stop <selector>
bun run orchestrator -- prompt <selector> <text> [--wait ms]
```

Selectors: `dN`, `all`, name glob (`api-*`), `label:k=v` (alias `tag:k=v`), `project:name`. `prompt --wait` correlates on the daemon's `agent_end` event and collects the final assistant text + usage per daemon; fan-out across a selector is the default.

### Spawn templates

Daemons are spawned from **command templates** — the orchestrator never hardcodes a launch method. `{cwd}` `{token}` `{name}` `{labels}` `{resume}` are substituted; the child's stdout is parsed for `OMPD|` contract lines; endpoint resolution order: wrapper `endpoint` line › template-declared `host` + listening port › `advertise` › loopback. Default local template:

```jsonc
// ~/.omp/orchestrator/config.json
{
	"roots": ["~/repos"],              // project discovery roots (one level deep, git repos + worktrees)
	"defaultTemplate": "local",
	"templates": {
		"local": { "command": "ompd --cwd {cwd} --port 0 --token {token} --name {name} {labels} {resume}" },
		"vm":    { "command": "ssh vm ompd --cwd {cwd} --port 4721 --host 0.0.0.0 --token {token} --name {name} {labels} {resume}", "host": "vm" }
	},
	"projectTemplates": { "my-project": "vm" },   // optional per-project override
	"spawnHook": "~/.omp/orchestrator/provision.sh" // optional; or OMP_ORCHESTRATOR_SPAWN_HOOK
}
```

Copy-pasteable examples live in `orchestrator/examples/` (`ssh-remote.json`, `docker.json` + wrapper, `provider-skeleton.sh` provision hook). The spawn hook (N3 hook point) is any script that creates a sandbox and prints `{ "name", "url", "token" }` JSON as its last stdout line; `provision <name>` runs it and registers the result.

### Security model

- Remote daemons are **dial-in only**: the orchestrator initiates every connection; a sandbox image contains zero knowledge of the external world (no orchestrator URL, no outbound credentials), and egress may be denied entirely.
- The bearer token inside a sandbox gates inbound connections to that daemon only — a leaked token grants nothing beyond it. Loopback peers are exempt; off-loopback requires the token (header, `?token=`, or a first-frame `hello`) and a secure transport (ssh `-L`, tailnet, or your own TLS).
- The orchestrator's UI binds loopback. For local children the token travels in the spawn environment — visible in `/proc/<pid>/environ`; accepted for the single-operator v1.
- `/download` stays realpath-jailed to the bound cwd + tmpdir + session dirs; it is the only file-egress path.

## The web UI (one app, two modes)

- **Standalone** (served by an ompd): the full single-session UI — chat, steering, queue chips, live bash/python streaming, rich tool cards, subagent roster + drill-down, settings panel (TUI `/settings` parity), OAuth login for 60+ providers, collab rooms (`omp join` TUI guests), session resume/branch/fork/handoff, `/btw` side questions, `/export` HTML transcripts.
- **Roster** (served by the orchestrator): the daemon sidebar replaces the sessions sidebar — status dots (`spawning`/`ready`/`asleep`/`reconnecting`/`error`), spawn picker (projects + worktrees + freeform path + template + labels), wake-on-click for asleep daemons, stop with confirm, per-daemon detail popover (cwd, uptime, labels, last session, stderr tail). Attaching proxies the browser through to that ompd; everything else about the UI is identical.

Collab from the CLI (standalone daemon):

```sh
bun run collab            # start the collab room, print write + view links
bun run collab -- --join  # …and open the TUI immediately
bun run collab -- --stop
```

## Develop

```sh
bun install
bun run dev:server      # ompd on :4721 (single-session)
bun run dev:web         # vite dev server on :4713 (proxies /ws + /download → 4721, /ctl → 4722)
bun run orchestrator -- serve   # orchestrator on :4722
```

Production: `bun run build:ompd` → self-contained `dist-bin/ompd` (UI embedded). Checks: `bun run check:types`, `bun test`.

## Architecture

- `server/index.ts` — the ompd daemon: one in-process SDK session, the 58-method dispatch allowlist, session event forwarding, `ui_request` dialog relay, settings model, OAuth login frames, bash/python/ephemeral streaming, subagent mirror, collab host adapter + relay, `/download` jail, static UI serving, bearer auth, readiness gate, idle auto-exit.
- `orchestrator/` — registry + JSON persistence (`registry.ts`), project discovery (`discovery.ts`), spawn templates + `OMPD|` parsing (`spawn-parse.ts`, `supervisor.ts`), dial-in connector with hello handshake, cwd sanity check, backoff and ping/pong liveness (`connector.ts`), selectors + fan-out correlation (`selectors.ts`, `fanout.ts`), loopback control API + CLI (`server.ts`, `cli.ts`), browser edge + per-browser daemon proxy + aggregated daemons panel (`edge.ts`, `daemons-aggregator.ts`).
- `src/protocol.ts` — the shared wire contract (client commands, server frames, `OMPD|` line, hello/`ready`, roster frames); additive changes only, gated by `OMPD_PROTO`.
- `src/state.ts` — client store: chat items, streaming, session state mirror, `call()` helper, reconnect with backoff, roster state, stale-frame guard (now guards daemon switches).

`docs/web-tui-parity-plan.md` is archived history; `ompd-plan.md` is the current architecture document.
