# AGENTS.md

Orientation for agents working in this repo. Read before editing. README.md is the user-facing doc; this file is the engineering map: commands, layout, wire contract, invariants, conventions, verification.

## What this repo is

Two products in one tree, sharing one Solid.js web UI and one wire contract:

- **omp-session** (`server/`) — single-session agent daemon. One process, one project dir (bound at spawn, immutable), one live agent session via the `@oh-my-pi/pi-coding-agent` SDK **in-process** (`createAgentSession` — no child process, no JSON-RPC hop). Serves the full standalone UI over SSE + POST. Builds to a self-contained binary.
- **omp-fleet** (`fleet/`) — registry + supervisor + connector for N daemons (local children, external/remote). Re-exposes them to the same UI in **roster mode** and to CLI fan-out. Holds **zero agent state** — all truth lives in the omp-session processes and their `.jsonl` session logs.
- **Web UI** (`src/`) — one Solid.js bundle serves both modes; mode is decided by the wire (`roster` frame ⇒ roster mode, sticky; a bare omp-session never sends it ⇒ standalone). No router.

Runtime is **Bun** (`type: module`, `bun.lock` committed). No CI. Lint runs through **oxlint** (`.oxlintrc.json`; Solid rules come from `eslint-plugin-solid` loaded as an oxlint JS plugin) and formatting through **oxfmt** (`.oxfmtrc.json`: tabs, print width 100, TS/TSX only — markdown/CSS/HTML/JSON stay hand-maintained). Comments reference audit findings as `finding #N` (numbering kept from the 2026-08 audit).

## Commands

```sh
bun install                    # once
bun run dev                    # roster mode: vite (HMR, /events+/command proxied to fleet edge) + omp-fleet — ports chosen per-run
bun run dev:single             # standalone: omp-session (--watch) + vite (proxies /events+/command+/download) — ports chosen per-run
bun run dev:server             # just the daemon, --watch
bun run dev:web                # just vite
bun run check:types            # tsgo -p tsconfig.json --noEmit  (tsgo = @typescript/native-preview, NOT tsc)
bun run lint                   # oxlint (.oxlintrc.json); warnings only don't fail the run
bun run format                 # oxfmt, writes in place (TS/TSX only)
bun run format:check           # oxfmt --check, exits nonzero on unformatted files
bun run test                   # scripts/test.ts wrapper → bun test (see Testing)
bun scripts/test.ts --bail 1   # extra args forwarded to bun test (file filters work: `bun scripts/test.ts server/omp-session.test.ts`)
bun run build                  # vite build → dist/ (gitignored)
bun run build:omp-session      # → dist-bin/omp-session self-contained binary (UI embedded via server/embedded-dist.ts)
bun run fleet -- serve|sessions|projects|spawn|add-repo|add|provision|stop|remove|rm-project|add-worktree|rm-worktree|prompt
bun run collab [-- --join|--stop]   # collab room CLI (TUI/CLI-only surface)
```

Ports: defaults vite **4713**, omp-session **4721**, omp-fleet **4722** (used by `dev:web`/`dev:server`/`fleet -- serve` run directly). The `dev`/`dev:single` runners instead pick ports per-run so parallel worktrees don't collide: backends bind port 0 (ephemeral; real port parsed from the `OMP_SESSION|` line / "fleet listening" banner), vite gets a probe-picked port with `--strictPort`, and a pre-ready exit is retried on a fresh port (bounded). Vite learns backend ports via `OMP_DEV_FLEET_PORT`/`OMP_DEV_SESSION_PORT` env in `vite.config.ts`. Dev mode: `bun run dev` sets `OMP_FLEET_LOCAL_TEMPLATE` so sidebar-spawned daemons run `bun server/index.ts` from the checkout (spawned daemons are not `--watch`ed — restart to pick up server edits). `--host`/`--allow-hosts` on dev commands bind vite to the network (backends stay loopback; see README for the tailscale host-check note).

## Repo layout

| Path | Role |
| --- | --- |
| `shared/protocol.ts` | The wire contract (see below). **Additive-only.** `OMP_PROTO` = 2 |
| `shared/sse.ts` | SSE framing (`encodeSseEvent`/`parseSseUnits`) + byte-bounded `SseRing` replay |
| `server/index.ts` | The daemon: bootstrap, `/events` + `/command`, dispatch + resync, `/download` jail, auth, readiness gate, idle auto-exit |
| `server/methods.ts` | `METHODS` dispatch table (57 `WebMethodName` rows) + `READ_ONLY` + `HISTORY_RELOAD` + `NOT_READY_GATED` sets |
| `server/config.ts` | Flag/env surface (`--flag` maps 1:1 to `OMP_SESSION_*` env) |
| `server/sse-delivery.ts` | Consumer registry, delta seqs, ring replay, broadcast, chunked history priming |
| `server/settings-model.ts` | TUI `/settings` parity model + side effects |
| `server/session-entry.ts` | `SessionEntry` interface, `BOOT_HANDLE = "s1"` (exactly one boot session) |
| `server/subagent-mirror.ts` | Subagent lifecycle/progress mirror + transcript paging |
| `server/ui-context.ts` | ExtensionUIContext dialogs → `ui_request`/`ui_response` frames |
| `server/collab-*.ts` | Collab host adapter / WS relay / session port / CLI. Only WebSocket left in the daemon (non-goal of the SSE plan) |
| `server/daemon-broker.ts` | `daemons` roster broadcast (hub-launch processes), polled every 3s while streams are live |
| `server/embedded-dist.ts` | **Stub** (`{}`) checked in; `build:omp-session` regenerates it with `with { type: "file" }` imports and restores the stub in a `finally`. Never hand-edit beyond the stub |
| `fleet/registry.ts` | Persistent insertion-ordered roster + registered `projects[]` (`~/.ompweb/fleet-state.json`, atomic tmp+rename; monotonic `pN` project ids) |
| `fleet/supervisor.ts` | Spawns/restarts omp-session children via templates, parses `OMP_SESSION|` lines, git polling |
| `fleet/connector.ts` | Per-daemon SSE client: status ladder, backoff, silence deadline, Last-Event-ID resume |
| `fleet/edge.ts` | Browser-facing half: `/events` downlink, `/command` uplink, per-browser daemon proxy pipes, aggregated `daemons` frame |
| `fleet/server.ts` | Loopback control plane `:4722`: `/ctl/*` routes (incl. `/ctl/projects[/:id]`, `/ctl/projects/:id/worktrees`, `/ctl/worktrees/:daemonId[/delete-info]`), wiring, boot reconcile |
| `fleet/cli.ts` | CLI over `/ctl/*` (loopback HTTP client) |
| `fleet/spawn-parse.ts` | Template fill, `OMP_SESSION|` parsing, endpoint resolution (pure) |
| `fleet/discovery.ts` | Project/worktree discovery, git state probing |
| `fleet/worktrees.ts` | Managed-worktree path mapping + lifecycle (`slugifyWorktreeName`/`managedWorktreePath`, `.ompweb-repo` collision markers, `resolveBaseRef`/`createWorktree`/`listUnregisteredWorktrees`/`deleteWorktree` + guard evidence; `git branch -d` only) |
| `fleet/selectors.ts`, `fleet/fanout.ts` | Selector grammar (`dN`, `all`, glob, `label:k=v`, `project:name`) + prompt fan-out correlation |
| `src/state.ts` | **The entire client model**: one `createStore`; chat items, streaming, session mirror, `call()`, roster, stale-frame guards |
| `src/components/` | Thin components: read `state` reactively, mutate only via exported store actions. No data props |
| `scripts/dev.ts`, `scripts/test.ts`, `scripts/build-omp-session.ts` | Dev runner, test wrapper, binary build |
| `docs/architecture.md`, `docs/position.md`, `docs/research/` | System architecture (wire contract, module map) + audit Phase 7 strategic items (findings #71–#80) + design-audit research (committed docs) |

## The wire contract (OMP_PROTO 2)

Transport is HTTP + SSE, no WebSockets on the agent-driving path:

- **Up**: `POST /command` — one `ClientCommand` per request, answered `202`; every command carries a client-supplied `id` (dedup window `COMMAND_DEDUP_WINDOW_MS` 60s / `COMMAND_DEDUP_CAP` 64). Answers ride the SSE stream as `call_result` frames.
- **Down**: `GET /events` — SSE, `event: frame`, `id: <seq>`, `data: <JSON ServerFrame>`. Priming (seqs 1..k): `hello_ok` → `attached` → `history` → `state` → `collab_status` → `available_commands` → `ready`. Then daemon-global delta seqs ≥ `SSE_DELTA_SEQ_START` (1024) via a byte-bounded `SseRing` (8 MiB / 10k entries), resumable via `Last-Event-ID`. Past `SSE_BACKPRESSURE_BYTES` (4 MiB) the stream is terminated in-band with a `stream_reset` frame (drop-and-resume; the daemon is ALIVE — do not treat the clean close as dormant).
- **Identity**: `hello_ok` is the FIRST event on every stream open (`proto`, `name`, `cwd`, `pid`, `version`, `sessionFile`). omp-session prints `OMP_SESSION|{...}` JSON contract lines on **stdout** (`event: listening` with bind/port/url, or `endpoint`); **all logs go to stderr**.
- **Priming on a bare omp-session**: `connect = attached` (every `/events` stream is attached to the single live session from open). The fleet edge **stamps** `sessionId = daemonId` on session-scoped frames and sends `attached` itself when proxying, so roster-mode clients can guard daemon switches.

Key constants (all in `shared/protocol.ts`): `OMP_PROTO = 2`, `SSE_KEEPALIVE_MS` 15s, `SSE_SILENCE_DEADLINE_MS` 30s, `SSE_RING_CAP` 10k, `SSE_RING_BYTES` 8 MiB, `SSE_DELTA_SEQ_START` 1024, `SSE_BACKPRESSURE_BYTES` 4 MiB.

## Invariants & conventions — read before editing

### Protocol (`shared/`)
- **Additive-only.** Adding a `WebMethodName`, `ClientCommand` variant, or `ServerFrame` variant is fine; changing or removing shapes is a **breaking change** → bump `OMP_PROTO` and coordinate the fleet connector + edge proto gates (`connector.ts` hello gate, `edge.ts` pipe gate) with it.
- New web-exposed methods need: union member in `protocol.ts` → dispatch row in `server/methods.ts` → handler in `server/index.ts` → client call sites in `src/state.ts` → tests.
- History over the backpressure cap ships as byte-bounded sequential `history` frames (`final: false` … `final: true`); small transcripts are one frame with no `final`. Client accumulates until `final`.

### Server
- **stdout is reserved for `OMP_SESSION|` lines; logs to stderr.** Spawners parse stdout.
- POST `/command`: `202` accept; dedup re-accepts duplicates. `READ_ONLY` methods (12 rows in `methods.ts`) skip post-mutation broadcast; `HISTORY_RELOAD` methods (`newSession`/`switchSession`/`branch`/`fork`/`handoff`) resync chunked history **before** `call_result`. `NOT_READY_GATED` = prompt-family calls fail `not_ready` until the readiness gate clears.
- Auth (R14): loopback peers exempt; off-loopback requires bearer (`Authorization: Bearer` or `?token=`); wrong credential → 401. Binding a non-loopback host without `--token` is a **startup error**.
- `/download` is realpath-jailed to cwd + tmpdir + session-file dirs — the only file-egress path. `list_files` never escapes cwd.
- Idle auto-exit (default `--idle-timeout 30m`): no attached clients, no running agent/queue, no in-flight bash/eval, no open dialog, no live collab room. `0` disables. The `.jsonl` is durable; fleet marks the entry `asleep` and respawns with `--resume`.
- One live session per process (`BOOT_HANDLE "s1"`). Mux commands (`create_session` etc.) are rejected as unknown — multiplexing lives in omp-fleet.

### Fleet
- **Zero agent state.** Fleet persists only roster metadata (endpoints, per-spawn bearer tokens, `lastSessionFile`, git branch/dirty counts) and re-derives everything else by dialing daemons.
- **Exclusive state locks.** Fleet state and session files are pidfile-locked for the owning process's lifetime, self-healing via pid liveness: a second fleet (or a second daemon resuming the same session file) refuses to start instead of clobbering state.
- **Tokens are minted fresh per spawn/restart and must NEVER be serialized** into roster frames or `/ctl/debug` (tests enforce this — `edge.test.ts` asserts `toRosterEntry` output). Same for endpoints in `/ctl/debug` snapshots.
- `dN` ids are monotonic and never reused. Registry persists atomically (tmp+rename) on every mutation.
- `pN` project ids are monotonic and never reused; projects are realpath-keyed and deduped on registration (a duplicate realpath returns the existing project); `removeProject` refuses while roster entries reference it and names the blockers. Projects persist in the same atomic state file as the roster, and the `registered_projects` frame must NEVER serialize tokens/endpoints (same rule as roster frames; `edge.test.ts` enforces it).
- Managed worktrees live under the `workspaceDir` knob (flag `--workspace-dir` > env `OMP_FLEET_WORKSPACE_DIR` > config-file `workspaceDir` key > `~/.ompweb/workspaces`; the root is created lazily on first worktree, never at boot). Deleting one requires ownership (realpath under `workspaceDir`) AND a clean tree — no `--force` in v1; the optional branch delete is `git branch -d` only, never `-D`. Session transcripts live under the agent dir, never inside the worktree, so worktree deletion never touches them.
- Status ladder is monotonic `connecting < session < resolving < ready`; `error` is terminal (only respawn refreshes). `hello_ok` gates: `OMP_PROTO` mismatch → terminal error; registered cwd vs `hello_ok.cwd` mismatch → `error cwd mismatch` (empty registered cwd → adopt hello's).
- Endpoint resolution order (spawn): last `{event:"endpoint"}` wrapper line › template `host` + listening port › `advertise` › loopback. 30s endpoint timeout → error + kill.
- Spawn templates: `{cwd}` `{token}` `{name}` `{labels}` `{resume}` substitution, `sh -c`, no shell escaping in `fillTemplate` (caller `shellQuote`s). `OMP_FLEET_LOCAL_TEMPLATE` replaces the `local` template command outright (dev runners).
- Remote entries are dial-in only; never probed with local git (branch/dirty counts are local-cwd-only).

### Frontend (`src/`)
- **One `createStore` in `src/state.ts` is the entire client model.** Components read `state` reactively and mutate only through exported actions. Don't introduce per-component state for shared data, and don't add a state library.
- **Markdown is ALWAYS `DOMPurify.sanitize(marked.parse(...))`** (`src/markdown.ts`) — model output is untrusted raw HTML.
- Streaming: deltas buffer in `pendingDeltas`, flushed ≤60/s via `requestAnimationFrame`; **mutate live blocks in place** (`setState('live','blocks',i,'text',…)`) — replacing block objects remounts `<For>` and kills the fade/scroll behavior.
- Stale-frame guards (in the `/events` onmessage handler, `src/state.ts`): drop session-scoped frames whose `sessionId !== currentSessionId` (`attach_result` exempt); dedup ring-replay via `seenFrameSeqs` per prime window; every attach/session-switch resets `nextId = 1` and rejects in-flight calls. `daemonRoster`/`daemons` survive session resets (fleet-scoped, not session-scoped).
- `sessionMode` (`'single' | 'roster'`) is set sticky by the `roster` frame; a proxied `attached` frame must never clobber it.
- Solid gotchas: use `untrack` when reading reactive objects inside effects you don't want to re-run (roster broadcasts replace daemon entries); `<Show when={…} keyed>` for object-identity-keyed rendering; `createRenderEffect` for imperative canvas (Pet); module-level state survives row remounts where component signals don't (e.g. `activatingIds` in DaemonSidebar).
- localStorage keys: `omp.sidebarVisible`, `omp.petVisible`, `omp.notifyEnabled`, `omp.sidebarGroupsCollapsed`, `omp-web:theme`, `omp-web:font-size`, `omp-web:history`.
- Styling: one global `styles.css` (73 KB), plain kebab-case feature-prefixed classes (`msg-*`, `tool-*`, `bash-*`, `settings-*`, `daemon-*`…), design tokens as CSS custom properties in `:root` (`--space-1..7`, `--r-*`, `--fs-*`, `--z-*`), theme palettes via `:root[data-theme=…]` overriding only `--*` vars. No CSS modules, no inline styles except rare one-offs.
- Dev handle: `window.__ompState` (DEV only). No router; modals keyed off `state.modal === …`.

### Tests
- `bun:test`, **co-located** `*.test.ts` next to source (`src/state.test.ts` ↔ `src/state.ts`, etc.). Run through `bun scripts/test.ts`, which pins `--parallel` to the machine's **physical** core count (logical-count workers oversubscribe HT/hybrid boxes and thrash the daemon-spawning suites), `--timeout 15000`, `--retry 0`. Extra args forward to `bun test`.
- **Heavy (spawn real daemons/processes)**: `server/omp-session.test.ts`, `server/collab-integration.test.ts`, `fleet/integration.test.ts` (real fleet + 3 real omp-session daemons, serial, hermetic `PI_CODING_AGENT_DIR` → no model → prompts fail with `ok:false` by design), `fleet/supervisor.test.ts` (fake `sh` children), `fleet/server.test.ts`, `fleet/edge.test.ts`. **Light/pure**: `src/*.test.ts` (state tested against a `FakeEventSource` + stubbed fetch), `shared/sse.test.ts`, `fleet/spawn-parse/selectors/events/daemons-aggregator/config/discovery/registry/fanout/connector.test.ts`, `server/settings-model/collab-relay/collab-host.test.ts`.
- Tests must not need a live model/API. Timers shrunk via connector opts / `OMP_SESSION_TEST_*` knobs. Suites must run from the repo root (`fleet/integration.test.ts` needs `server/index.ts`).
- `server/collab-relay.test.ts` deliberately never calls `server.stop()` (Bun hangs closing sockets with close codes — verified against bun 1.3.14); don't "fix" that.

### Style
- Tabs for indentation (enforced by oxfmt). `verbatimModuleSyntax` is on → `import type` discipline (no value imports of types).
- Typecheck with `tsgo` (`bun run check:types`); the `@typescript/native-preview` version is pinned exactly. NOTE: typescript-eslint/ESLint cannot run against TS 7 — that's why linting is oxlint, not ESLint.
- Comments reference audit remediation findings as `finding #N` (numbering kept from the 2026-08 audit; the strategic items live in `docs/position.md`); keep the numbering when fixing/annotating.
- `dist/`, `dist-bin/`, `node_modules/` are gitignored; `docs/architecture.md`, `docs/position.md`, `docs/research/` are committed docs — update, don't delete.

## Editing workflows

**Add a web-exposed method**: 1) add to `WebMethodName` in `shared/protocol.ts`; 2) row in `METHODS` (`server/methods.ts`) — classify `READ_ONLY` / `NOT_READY_GATED` / `HISTORY_RELOAD`; 3) handler in `server/index.ts` (post-mutation broadcast unless READ_ONLY; resync-before-`call_result` for HISTORY_RELOAD); 4) `call()` from `src/state.ts` + UI; 5) tests.

**Add an SSE frame**: 1) variant in `SessionScopedFrame` or `ServerFrame` (additive); 2) emit site in `server/sse-delivery.ts` broadcast path; 3) client handling in `src/state.ts` (apply stale-frame guards if session-scoped); 4) tests.

**Breaking handshake/frame change**: bump `OMP_PROTO` in `shared/protocol.ts` AND update the proto gates in `fleet/connector.ts` (hello) and `fleet/edge.ts` (pipe) so old/new peers fail loudly instead of misparsing.

**Bug fix**: reproduce first (heavy suites give you the seams: hermetic fake daemons in `fleet/`, `FakeEventSource` in `src/state.test.ts`), then fix, then confirm the reproduction no longer triggers. Don't suppress warnings/errors to make tests green — the suite uses `--retry 0` and `--timeout 15000`; flaky-by-design is not acceptable.

## Verification

After any change: run the **targeted test file(s)** (`bun scripts/test.ts <file>`), then `bun run check:types`, then the full `bun run test` when the change touches shared/daemon/edge paths. UI changes: `bun run dev` (or `dev:single`) and verify in a browser against the actual surface — roster mode on :4713 with the fleet edge, standalone against the daemon. Readiness is observable: the daemon's `OMP_SESSION|` line, vite's `Local:` line, fleet's control API answering `/ctl/sessions`.
