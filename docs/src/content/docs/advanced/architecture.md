---
title: Architecture overview
description: "A developer map of omp-web: the omp-session and omp-fleet runtime products, the browser topology, state ownership, process and session persistence, the SSE and POST wire, import boundaries, and security boundaries."
---

This page is for developers and maintainers who need the shape of the system before changing it. It covers the two runtime products, the topology between the browser and session daemons, state ownership, how processes and sessions persist, the wire transport at a conceptual level, the import boundaries between layers, and where the security boundaries run. It is supporting material: none of it is required to operate omp-web.

Two repository documents remain authoritative, and this page replaces neither:

- [`docs/architecture.md`](https://github.com/nibblebot/omp-web/blob/main/docs/architecture.md) for the wire contract, frame shapes, protocol constants, and the full module map.
- [`AGENTS.md`](https://github.com/nibblebot/omp-web/blob/main/AGENTS.md) for engineering invariants, conventions, and verification workflows.

One carried-over reference in the canonical document points to a companion position paper (`docs/position.md`) that is not present in the repository. Treat that link as historical.

[Projects, worktrees, session daemons, and sessions](/concepts/projects-worktrees-session-daemons-sessions/) introduces the product vocabulary. Start there if terms such as session daemon or worktree are new.

## The two products

The repository holds two runtime products plus the browser client they both serve.

| Layer | Product | Role |
| --- | --- | --- |
| `server/` | `omp-session` | One process bound to one directory for its entire life, hosting one live agent session. Runs the `@oh-my-pi/pi-coding-agent` SDK in process (`createAgentSession`; no child process, no JSON-RPC hop) and serves the full standalone UI over SSE and POST. |
| `fleet/` | `omp-fleet` | A registry, supervisor, and browser edge for N session daemons. Spawns local children from command templates, dials remote endpoints, proxies the browser to the selected session daemon, and serves the loopback control plane the `omp-web` CLI uses. Holds zero agent state. |
| `src/` | Web UI | One Solid.js bundle that serves both modes. There is no router and no second frontend. |

The installed `omp-web` entrypoint dispatches to both: bare `omp-web` (or `omp-web serve`) is the fleet, and `omp-web session` is one standalone session daemon.

The two products share the wire contract in `shared/protocol.ts` and the SSE codec in `shared/sse.ts`. The current protocol version is `OMP_PROTO` 2. Evolution is additive-only: adding a frame or command is safe, while changing or removing a shape requires bumping the constant and updating both proto gates (`fleet/connector.ts` on the control dial, `fleet/edge.ts` on the browser pipe) so old and new peers fail loudly instead of misparsing.

Mode is decided by the wire, not by a build or a setting. The fleet edge sends a `roster` frame, which puts the client into roster mode for the life of the page; a bare `omp-session` never sends one, so its clients stay in single-session mode. See [Fleet and single-session modes](/concepts/runtime-modes/).

## Topology

```text
standalone mode
  browser --POST /command--> omp-session (one bound directory, one live session)
          <--SSE /events----

roster mode
  browser --POST /command--> omp-fleet edge --proxy--> selected omp-session
          <--SSE /events---- (registry + proxy)        (per-browser pipe)

background connections
  omp-fleet supervisor --spawn/restart--> local omp-session children
  omp-fleet connector  --dial in--------> local and remote session daemons
```

In roster mode the browser never talks to a session daemon directly. It attaches to a roster row, and every command and frame is proxied through the fleet edge, which keeps one pipe per attached browser. The edge also retains a dial-in connector stream per session daemon so status, activity, and the roster stay live while a browser is connected.

Connections are dial-in in both directions of ownership. The fleet supervisor spawns local session daemons as child processes from command templates, and the connector dials every session daemon, local or remote, with a per-daemon bearer token. Remote session daemons are registered by endpoint and dialed; they are never spawned by the fleet, they never dial out, and they never learn the fleet's address, state file, or any other session daemon's token. A sandboxed host can therefore deny outbound traffic entirely.

Local spawns report their endpoint by printing a machine-readable `OMP_SESSION|` JSON line on stdout immediately after bind, before the session exists. All human logs go to stderr, and the supervisor parses stdout to learn where the child is listening.

## State ownership

The agent SDK session inside the `omp-session` process and its JSONL transcript on disk are the single agent truth. Everything else is a mirror or a projection.

- **Session daemon.** The live session holds the transcript, model and provider state, queues, tool calls, and open dialogs. The transcript is written durably as it goes, which is what makes the process disposable.
- **Fleet.** The registry persists only roster metadata: registered projects, per-daemon endpoints, the per-spawn bearer token, the last session file, the probed session title and emptiness, and git branch and dirty counts for local checkouts. It mirrors defined wire points rather than inventing state: the bound directory from the validated `hello_ok` handshake, the session file from hello and state frames, readiness from the `ready` frame. There is no conversation content, queue, dialog, or model state in the fleet.
- **Browser.** One `createStore` in `src/state.ts` is the entire client model. The per-session view resets on every attach, and session-scoped frames whose stamped `sessionId` does not match the current session are dropped, so switching rows cannot carry stale frames across. Roster state is fleet-scoped and survives session switches. The only browser persistence is `localStorage` preferences and prompt history.

Nothing assumes process permanence. Restarting the fleet loses no agent state because the fleet never held any; the durable record is always the transcript on disk.

## Processes and sessions

A session daemon is bound to one directory at start, and that binding is immutable for the process lifetime. It hosts exactly one live session. Session replacement actions (`newSession`, `switchSession`, `branch`, `fork`, `handoff`, `compact`, `retry`, `freshSession`) run sequentially and change what the live session is; they never add a second one. Concurrency lives one layer up, in several session daemons.

Three lifecycle gates shape the process:

- A **boot gate** preserves the connect-implies-attached invariant for streams that race session creation.
- A **readiness gate** fails prompt-family calls with `not_ready` until provider, model, and authentication resolution completes and the session daemon broadcasts `ready`.
- **Idle auto-exit** shuts the process down cleanly after the idle timeout (30 minutes by default, `0` disables) once nothing is attached and nothing is running: no attached stream, running agent or queue, in-flight bash or eval, open dialog, or live collab room. The transcript is already durable, so the exit is safe.

Persistence and recovery follow from that:

- A stopped or exited session daemon restarts with `--resume` and the transcript is back. The fleet marks the row asleep and wakes it the same way; a row that has no session file starts a fresh session.
- Fleet state and session files are pidfile-locked for the owning process's lifetime, self-healing via pid liveness. A second fleet, or a second session daemon resuming a transcript that is already in use, refuses to start instead of clobbering state.
- Crash restart is bounded: the supervisor serializes respawns per session daemon, passes `--resume`, and stops restarting when a consecutive-crash budget is exceeded. Intentional stops and manual respawns are flagged so expected deaths do not trigger restarts.
- Remote entries are redialed with jittered exponential backoff, never respawned. A fleet restart brings local rows back asleep (their child processes exited with the fleet) and redials remote rows.
- Transcripts live outside the worktrees, in the agent directory, so deleting a worktree never orphans a session.

See [Session persistence](/concepts/session-persistence/) and [Session daemon lifecycle](/concepts/session-daemon-lifecycle/) for the user-visible view.

## The wire, conceptually

Transport is HTTP with SSE, and there is no WebSocket on the agent-driving path.

- **Commands go up.** `POST /command` carries one `ClientCommand` per request and answers `202`, with answers arriving on the stream. Commands are idempotent by a client-supplied id inside a bounded dedup window, so a retried command is accepted without re-dispatching.
- **Everything goes down one stream.** `GET /events` is one SSE stream carrying every frame type. Every stream opens with a priming sequence: `hello_ok` (protocol version, name, bound cwd, pid, version, session file), then `attached`, `history`, `state`, `collab_status`, `available_commands`, and `ready`. Connect implies attached.
- **Resume is built in.** After priming, frames carry daemon-global monotonic sequence numbers, and a bounded replay ring lets a reconnecting consumer resume with `Last-Event-ID`. Priming is always fresh and current, so a stale client skips replay.
- **Keepalive and liveness.** Id-less `ping` events keep the stream warm and never advance the resume counter; a consumer that sees twice the keepalive interval of total silence treats the peer as dead and reconnects.
- **Backpressure is drop-and-resume, not loss.** A stream whose enqueue would exceed the byte cap is terminated in-band with a `stream_reset` frame. The session daemon is alive, and the consumer redials with `Last-Event-ID`; the replay ring covers the gap.
- **Drift is gated.** `hello_ok.proto` must equal `OMP_PROTO`, and the handshake's reported cwd must match the registered directory. Both the connector and the edge pipe fail closed on mismatch, parking the entry in `error` rather than driving a mismatched session daemon.
- **Fleet-scoped frames ride the same stream.** The roster, per-daemon status, real-time activity, session listings, and registered projects are additive frames the edge generates; session-scoped frames are stamped with the roster daemon id as `sessionId` so roster-mode clients can guard session daemon switches.
- **Collab is the one WebSocket surface.** The end-to-end encrypted relay at `/r/<roomId>` is hosted and joined through the CLI or TUI only; the browser UI has no collab surface.

Frame shapes, constants, and the evolution rules live in the canonical document. Start with [`shared/protocol.ts`](https://github.com/nibblebot/omp-web/blob/main/shared/protocol.ts) for the source of truth.

## Import boundaries

Layering is strictly leaf-ward, and the seams are deliberate:

- **`shared/`** is the leaf: `protocol.ts` (wire contract and constants) and `sse.ts` (SSE framing and replay ring). It imports nothing else in the repository.
- **`server/`** imports from `shared/` only.
- **`fleet/`** imports from `shared/`, plus exactly two deliberate `server/` exceptions: `edge.ts` pulls the embedded UI bundle constant from `server/embedded-dist` to serve the web app, and `settings.ts` reuses the settings metadata helpers from `server/settings-model` for the unattached settings surface. Nothing else crosses that seam.
- **`src/`** imports repository code from `shared/` only, and imports neither backend layer. Its references to SDK packages are type-only.

Agent-SDK touchpoints in the fleet are narrow. The core modules (registry, supervisor, connector, edge) hold no agent state; the omp-stack probe and the per-worktree session listing load the SDK behind lazy dynamic imports, and the unattached settings service reads the process-global settings singleton. None of them hold a live agent session.

## The zero-agent-state invariant

The fleet's defining invariant is that it holds zero agent state. All agent truth lives in the `omp-session` processes and their JSONL logs; the fleet keeps only what it needs to operate a roster.

- The state file holds roster metadata and credentials, never conversations, queues, or live session state.
- Status, liveness, activity, and session listings are re-derived by dialing session daemons, not stored as truth.
- Removing or stopping a row touches the registration and the process, never the transcript.
- Restarting or replacing the fleet costs nothing durable. Locally spawned rows come back asleep and are woken with their last session.

Two hygiene rules protect that boundary on the browser side: bearer tokens, endpoint URLs, and spawn templates are never serialized into roster frames, and diagnostics expose endpoints but never tokens. Tests enforce the serialization rule.

## Security boundaries

The architecture keeps agent control behind narrow, fail-closed boundaries. The full operator view, including the responsibilities that stay with you, is in [Security model](/operations/security/).

- **Dial-in only.** The fleet initiates every connection. `omp-session` has no fleet flag, never dials out, and never learns the fleet's address or credentials.
- **The fleet plane is loopback only.** The browser edge, the `/ctl` control plane, and the stats routes share one loopback bind with no bearer token on that plane, so reaching it from another machine means tunneling to loopback.
- **Session daemons authenticate with a per-daemon bearer token.** Tokens for fleet-spawned session daemons are minted fresh for every spawn attempt, and a registered remote entry carries the token supplied at registration; either way a leaked token gates exactly one session daemon. Loopback peers are exempt, and any off-loopback bind requires a token, with a non-loopback bind without one a startup error. Off-loopback requests without the exact token get `401` before any protocol exchange.
- **Roster hygiene.** The browser never receives tokens, endpoints, or spawn templates.
- **File egress is jailed.** `/download` canonicalizes with realpath and allows only the bound working directory, the process working directory, the temp directory, and the session file's directory; file listing never escapes the bound directory. The agent itself is not sandboxed: bash and python run with the account's filesystem access, and dialogs are a UI affordance, not an operating-system boundary.
- **Collab hosts** require the session daemon token off loopback, while guests join with the end-to-end room key.

## Where the details live

- Canonical architecture document: [`docs/architecture.md`](https://github.com/nibblebot/omp-web/blob/main/docs/architecture.md) remains authoritative for protocol details, frame shapes, and the module map.
- Engineering invariants and workflows: [`AGENTS.md`](https://github.com/nibblebot/omp-web/blob/main/AGENTS.md).
- Wire source of truth: [`shared/protocol.ts`](https://github.com/nibblebot/omp-web/blob/main/shared/protocol.ts) and [`shared/sse.ts`](https://github.com/nibblebot/omp-web/blob/main/shared/sse.ts).

Related pages:

- [Fleet and single-session modes](/concepts/runtime-modes/)
- [Projects, worktrees, session daemons, and sessions](/concepts/projects-worktrees-session-daemons-sessions/)
- [Session persistence](/concepts/session-persistence/)
- [Session daemon lifecycle](/concepts/session-daemon-lifecycle/)
- [Local and remote sessions](/concepts/local-and-remote/)
- [Security model](/operations/security/)
- [Diagnostics](/operations/diagnostics/)
