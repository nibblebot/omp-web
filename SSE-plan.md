# SSE-plan: remove WebSockets, adopt POST (client→server) + SSE (server→client)

Status: implemented (OMP_PROTO 2). Deviations from this plan, decided during verification:
1. **Keepalive is a named `ping` event** (`event: ping\ndata: {}\n\n`, no id), not a `: ping` comment — native EventSource drops comments without surfacing them, so the browser could not implement the silence deadline. `SSE_PING_BLOCK` in `src/sse.ts`.
2. **Edge command routing carries a client id**: the browser appends `?client=<id>` to `/events` and sends `X-Omp-Client-Id: <id>` on every POST /command; the edge binds streams/rings/pipes by it (POST is connectionless, so per-browser routing needs an explicit identity). Missing/unknown → 400 on the edge; the bare daemon ignores it.
3. **`idleTimeout: 0` on both Bun.serve instances** — Bun's default 10s fetch idle timeout kills quiet SSE responses between 15s pings.

## Goal

Replace every WebSocket transport in the agent-driving path with:

- **POST** for client→server commands (idempotent, retryable, durable-queue shaped)
- **SSE** for server→client frames (resumable via `Last-Event-ID`, survives middleboxes)

Execution stays decoupled from connection liveness: the daemon keeps running, any
consumer reconnects and resumes from a sequence number. This is the transport
swap, not a protocol redesign — frame shapes (`ClientCommand`, `ServerFrame`)
survive verbatim; they move from WS frames to POST bodies / SSE event payloads.

## Non-goals (explicit scope cuts)

- **Collab relay stays WebSocket.** `server/collab-relay.ts` (`/r/<roomId>?role=…`)
  is a separate binary protocol (AES-GCM envelopes, TEXT controls) owned by
  `@oh-my-pi/pi-coding-agent/collab`, shared with the TUI collab mux. Rewriting
  it breaks the external protocol. It is not the agent-driving channel.
  `server/collab-host.ts`, `collab-relay.test.ts`, `collab-host.test.ts`,
  `collab-integration.test.ts` are untouched except where they open the *web*
  `/ws` socket (see collab-cli below).
- No change to `/download`, static serving, `/ctl/*` REST routes, or the
  `OMP_PROTO` frame vocabulary other than the diffs listed below.
- No behavioral change to auth rules (R14): loopback exempt; off-loopback needs
  bearer token via `Authorization` header or `?token=`. Wrong header → 401.

## Target wire contract

### Endpoints (daemon, `server/index.ts`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/events` | SSE stream: all `ServerFrame`s, primed + deltas, resumable |
| POST | `/command` | One `ClientCommand` (JSON body) per request |

Fleet edge exposes the same two endpoints to browsers and relays to daemons
internally (see Edge section). Endpoint URL derivation: registered daemon
endpoints are pathless `ws://`/`wss://` → base `http(s)://host:port`, paths
appended (`daemonWsUrl` becomes `daemonHttpBase`).

### SSE framing (both legs)

```
event: frame
id: <seq>
data: <JSON ServerFrame>

```

- `<seq>` is a per-stream monotonic integer starting at 1. Priming frames carry
  seqs too; the consumer's resume point is a single counter.
- Keepalive: server writes a comment line `: ping\n\n` every 15s
  (`DEFAULT_PING_INTERVAL_MS` reused). Consumers treat >30s of total silence
  (no event, no comment) as a dead peer → reconnect (renamed
  `DEFAULT_SILENCE_DEADLINE_MS`; the old 10s pong timeout dies with ping/pong).
- Auth on GET: `Authorization: Bearer <token>` or `?token=`; loopback exempt;
  wrong header → `401`. No hello window, no 4001 close —
  `OMP_CLOSE_UNAUTHORIZED` and `HELLO_WINDOW_MS` are deleted. The
  `hello`/`hello_ok` handshake is replaced by HTTP-level auth; `hello_ok` is
  emitted as the **first event** on every stream open (daemon identity:
  name/cwd/pid/version/sessionFile — unchanged shape).

### Resume (snapshot + deltas)

The daemon keeps a bounded ring buffer of recent deltas (cap 10_000 events).
On every `/events` open:

1. Emit priming (fresh, current): `hello_ok` → `attached` → `history` →
   `state` → `available_commands` → `ready` (same sequence as today's
   connect=attached priming).
2. If the client sent `Last-Event-ID: N` and N ≥ priming seq: replay ring
   events with seq > N.
3. If N < priming seq (stale/empty client): skip ring replay — priming already
   carries full current state; superseded deltas are dropped.

Ring replay is the replacement for "reconnect → daemon re-sends state" — and it
is protocol-native instead of hand-rolled. Consumers dedup by event/command id
(replay can double-deliver): `call_result` only resolves a pending `call`;
duplicate frames for unknown ids are ignored.

### POST /command

- Body: `ClientCommand` JSON. Response: `202 {"commandId": <id>}` on accept.
- Answers ride the `/events` stream as today's frames (`call_result`,
  `sessions`, `files`, `hello_ok`, …). The SSE stream is the single answer
  channel — POST is fire-and-forget accept, which keeps one delivery path.
- Idempotency: the daemon dedups by the client-supplied `id` (already on
  `call`/`ui_response`; add to the remaining commands) within a window (last
  64 ids / 60s). Duplicate → `202` again; the client's replay covers any lost
  answer.
- Fleet-level commands (`spawn`, `spawn_resume`, `stop`, `remove`,
  `list_projects`, `attach`) are edge-only today; they stay POST targets on the
  edge, never proxied to the daemon.

### protocol.ts diff (`src/protocol.ts`)

- `OMP_PROTO` 1 → 2 (breaking handshake change).
- `ClientCommand`: remove `hello`. Everything else unchanged (they become POST
  bodies).
- `ServerFrame`: shapes unchanged (they become SSE payloads); document
  `hello_ok` = first event on stream open.
- Delete `OMP_CLOSE_UNAUTHORIZED`. Add SSE framing constants (event field,
  comment interval, ring cap).

## Per-file changes

### Daemon — `server/index.ts` (84.8KB)

- `fetch` handler: delete the `/ws` upgrade block (lines ~1892-1906). Add:
  - `GET /events` → R14 check → attach to boot session (connect = attached
    preserved) → return `Response` with `ReadableStream` body; write priming +
    ring replay; keepalive comment timer; register stream in the socket set.
  - `POST /command` → R14 check → parse `ClientCommand` → existing dispatch
    (`onSocketMessage` body, minus the auth/hello preamble at ~1601) → `202`.
- Socket bookkeeping (`sockets` Set, `attachSocket`, `helloTimers`) becomes
  stream-keyed: each SSE connection is one consumer with `{ attached, ring,
  buffer }`. `startDaemonPoll` (5s process_stats) writes to all live streams.
- `pendingCodeInputs` / `pendingUiRequests` stay keyed per connection; a
  dropped stream rejects them (same as socket close today).
- Backpressure: per-stream enqueue beyond 4 MiB (`DEFAULT_BACKPRESSURE_BYTES`
  reused) → terminate that stream (client reconnects with `Last-Event-ID`;
  ring covers the gap). This is today's drop-and-mark expressed as
  drop-and-resume; the ring buffer is the mark.
- Idle: existing 15s idle tick semantics unchanged, keyed on live streams.

### Daemon CLI — `server/collab-cli.ts`

- `openSocket()` (`ws://…/ws`) → open `/events` via `fetch` + stream parse;
  `send()` → `POST /command`. Collect/answer logic unchanged. (Guest/relay
  sockets, if any, untouched.)

### Fleet connector — `fleet/connector.ts` (20.8KB)

- `DaemonConnector` becomes an HTTP client:
  - Dial = `fetch(base + "/events", { headers: { Authorization } })`, parse the
    body stream (SSE parser: event/data/id + comment-skip). AbortController =
    the socket handle.
  - Commands = `POST /command` with the bearer header.
  - Status ladder unchanged, driven by SSE events instead of `ws.onmessage`:
    `connecting` → (`hello_ok` event) `session` → (first `state`) `resolving`
    → (`ready`) `ready`.
  - Reconnect: same jittered backoff (1s→30s), but resume sends
    `Last-Event-ID: lastSeq+1`; `onDialFailed` respawn path unchanged.
  - Keepalive: delete `startSocketKeepalive` (ping/pong, `onpong` hack). New:
    silence deadline timer — no event/comment for 30s → treat as dead →
    reconnect.
  - Idle policy (`retain`/`release`, `idleDropMs`): AbortController.abort() —
    no status change, same as today's clean drop.
- `daemonWsUrl` → `daemonHttpBase` (normalize scheme/path; append
  `/events`, `/command`).

### Fleet edge — `fleet/edge.ts` (28.9KB) + `fleet/server.ts` (17.8KB)

- Browser surface: `/ws` upgrade → `GET /events` (SSE) + `POST /command` on the
  edge. `onSocketOpen/Message/Close` → stream open/command/release handlers.
  Roster unicast on open and `daemon_status`/`roster` broadcasts become SSE
  events (edge-local seq per browser stream).
- Pipes: a browser `attach` opens a **dedicated daemon `/events` stream**
  (edge → daemon, same bearer token, `daemonHttpBase`), replacing the per-browser
  daemon WS pipe. Edge stamps `sessionId` on daemon-origin frames before
  forwarding to the browser stream (unchanged behavior). Browser commands on an
  attached session proxy to `POST /command` on that daemon. `retain`/`release`
  feeding the connector's idle policy unchanged.
- Backpressure: browser-stream enqueue beyond 4 MiB → drop that stream; browser
  reconnects (`Last-Event-ID`), edge re-attaches to the daemon and replays its
  per-browser ring. Same isolation as dedicated pipes — one slow browser never
  stalls the daemon stream or other browsers.
- `daemons-aggregator.ts` taps the connector control stream + attach streams as
  today (it reads frames; stream source is transparent).
- `fleet/server.ts`: delete the `websocket: {…}` wiring block; everything is
  fetch-handled. `supervisor.ts`, `fanout.ts`, `cli.ts`, `registry.ts`,
  `discovery.ts` need no transport changes (they consume connector/registry
  APIs, never raw WS — verified: no WebSocket references in those files).

### Browser — `src/state.ts` (52.3KB)

- Replace the `ws` singleton (~line 780, connect at ~1177) with:
  - **EventSource** for the downlink: `new EventSource("/events")` (token via
    `?token=` when configured — EventSource cannot set headers; loopback is
    exempt so the default dev path needs nothing). Native auto-reconnect sends
    `Last-Event-ID` automatically. Handle `readyState === CLOSED` in `onerror`
    for the 401/no-retry case with a manual reconnect + backoff (keep the
    existing 1s→backoff reset logic as a wrapper).
  - **`fetch POST /command`** for every sender: `call`, `listSessions`,
    `listFiles`, `listProjects`, `spawnDaemon`, `spawnResume`, `stopDaemonById`,
    `removeDaemonById`, `sendLoginCode`, `sendUiResponse` ×2, `attachToDaemon`,
    `startCollab`, `stopCollab`, `daemonLogs`, `daemonStop`, `daemonRestart`,
    `getProcessStats`. Each keeps its `{ type, id }` payload; the
    `readyState === OPEN` guards become "connected" checks; pending promises
    still resolve on the matching answer frame, deduped by id.
- The mixed-content `wss/ws` switch (~1177) dies — EventSource/fetch are
  same-origin `http(s)`, no mixed-content problem.
- `src/commands.ts` comment about "unreachable over the WebSocket protocol"
  (~282): update wording, no logic change.

### Infra + docs

- `vite.config.ts`: proxy `/ws` → replace with `/events` (target
  `http://${sessionTarget}` — http-proxy streams SSE; no `ws: true` needed) and
  `/command`. `/download`, `/ctl` unchanged. `scripts/dev.ts` comment about
  `/ws` proxying updated (paths only).
- `README.md`: "served … over WebSocket" → SSE + POST; dev-mode proxy
  descriptions (lines ~21, ~29, ~142-143).
- `scripts/build-omp-session.ts`, `dist-bin/`: no change (bundles the same
  server).

## Test plan (per-file, lands with each phase)

- `server/omp-session.test.ts`: helpers `openWebSocket`/`collect`/
  `expectHelloOk` → SSE client (fetch + parser) + `postCommand`. R14 suite:
  header auth → 200/202; `?token=` → same; loopback exempt; wrong header →
  401 (4001/hello-window tests deleted). Priming-order tests read first events
  instead of first frames. Idle-tick test targets an open `/events` stream.
- `fleet/connector.test.ts`: `FakeServer` Bun.serve upgrades → `/events` + `/command`
  handlers (prime via SSE events). Silent-peer test: raw-TCP WS server that
  never answers pings → fake SSE server that stops sending comments; silence
  deadline drives the same reconnect assertions. Backoff caps, idle-drop,
  waitReady, frame fan-out, `Last-Event-ID` resume: all keep their assertions,
  exercised over the new transport.
- `fleet/edge.test.ts`: `BrowserSocket` (WS) → browser SSE+POST client. Fake
  omp-session → HTTP. Backpressure tests: overflow → stream dropped → browser
  reconnects → replayed frames arrive.
- `fleet/server.test.ts`, `fanout.test.ts`, `supervisor.test.ts`: fake daemons
  → HTTP (same assertions).
- `fleet/integration.test.ts`: real daemons via `startFleet` — spawn template
  unchanged (`bun server/index.ts …`); assertions unchanged; it already talks
  "over the HTTP control plane".
- New unit tests: SSE line parser; POST idempotency/dedup; ring-buffer replay
  (fresh vs stale `Last-Event-ID`); drop-and-resume backpressure.

## Implementation order

1. **Wire contract** — `protocol.ts`: `OMP_PROTO` 2, drop `hello`, framing
   constants, delete `OMP_CLOSE_UNAUTHORIZED`. Types only; nothing runs.
2. **Daemon** — `server/index.ts` `/events` + `/command`, ring + replay,
   keepalive comments, backpressure drop, stream-keyed state; delete `/ws` +
   hello window; `collab-cli.ts` flip. Rewrite `server/omp-session.test.ts`.
   Verify: `bun test server/omp-session.test.ts`; curl smoke —
   `curl -N -H "Authorization: Bearer t" localhost:4721/events` streams frames;
   `curl -X POST …/command` returns 202; off-loopback → 401.
3. **Fleet connector** — `connector.ts` SSE client + POST; silence deadline;
   `Last-Event-ID` resume; AbortController idle drop. Update
   `connector/fanout/supervisor` tests. Verify: `bun test fleet/connector.test.ts`.
4. **Fleet edge** — `edge.ts` browser SSE+POST, attach streams, edge ring +
   drop-and-resume; `server.ts` deletes websocket wiring. Update
   `edge.test.ts`, `server.test.ts`. Verify: `bun test fleet`.
5. **Browser** — `state.ts` EventSource + `postCommand`. Verify: `bun run dev`
   and `bun run dev:fleet` smoke — open UI, prompt, watch streaming, attach,
   daemon logs/stop/restart.
6. **Infra + docs** — `vite.config.ts`, `scripts/dev.ts`, `README.md`.
7. **Full verification** — `bun test` (whole suite), `bun run check:types`,
   both dev modes; kill/restart the daemon mid-session (`dev:server` watch
   restart) and confirm the browser resumes with replayed deltas; R14 curl
   checks above.

## Risks & decisions

| Item | Decision | Why |
|---|---|---|
| Collab relay stays WS | out of scope | external binary protocol; separate feature |
| Browser uses EventSource | yes | native auto-reconnect + `Last-Event-ID`; headers not needed (loopback / `?token=`) |
| EventSource 401 stops retrying | manual `CLOSED` → reconnect wrapper in `state.ts` | auth errors shouldn't loop forever |
| Server-side consumers use fetch, not EventSource | yes | need `Authorization` header |
| Answers ride `/events`, POST returns only 202 | yes | one answer channel; replay dedup by id |
| Backpressure = drop stream + resume | replaces drop-and-mark | ring buffer is the mark; no mid-stream drop signal needed |
| N+1 daemon streams (control + per attach) | accepted | preserves per-attach isolation; SSE streams are cheap |
| Browser HTTP/1.1 6-connection limit | non-issue | app uses exactly one `/events` per browser; daemon streams are server-side |
| Buffering proxies | note for deployment | dev (http-proxy) streams fine; prod reverse proxy needs `proxy_buffering off` / `X-Accel-Buffering: no` for `/events` |
| POST latency | accepted | one RTT per command, same network path as today's frames |
| Replay double-delivery | consumers dedup by id | `call_result` resolves pending only; unknown ids dropped |

## Open items to confirm while implementing

- `attachSocket` body in `server/index.ts` (beyond the priming order already
  cited) — verify no socket-specific behavior besides the three tracked maps.
- Whether the edge's per-browser ring needs a separate cap from the daemon's
  (recommend same 10_000 / 4 MiB constants).
- `integration.test.ts` timing constants: resume replay may add a priming round
  trip; generous waits already exist.
