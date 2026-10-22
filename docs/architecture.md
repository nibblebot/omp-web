# Architecture: browser, fleet, session

omp-web has three tiers. The **browser** runs the Solid UI. The **fleet** (`omp-web`, or `omp-web control`) is the control plane: roster, workspace lifecycle, and the browser edge. Each **session** (`omp-web session`) is one daemon process that runs one in-process SDK agent against one project directory. The durable record of what an agent did is the session's `.jsonl` transcript; the fleet holds no agent state.

There are two protocol hops, versioned separately:

| Hop | Transport | Version | Source of truth |
|---|---|---|---|
| Browser to fleet | `GET /events` (SSE, down) and `POST /command` (up) | `OMP_PROTO` 4 | `lib/wire/protocol.ts` |
| Fleet to session (the callback pair) | One WebSocket, `GET /callback/ws`, dialed by the session; `POST /callback/bulk/<id>` for large transfers | `OMP_CALLBACK_PROTO` 2 | `lib/wire/callback-protocol.ts` |

## Components

```mermaid
flowchart LR
  subgraph client["Browser"]
    ui["Solid UI<br/>one store (state.ts)"]
  end

  subgraph cp["Fleet control plane (omp-web / omp-web control)"]
    edge["Browser edge (edge.ts)<br/>per-browser SSE ring, command routing,<br/>sessionId stamping"]
    transport["Callback transport (daemon-transport.ts)<br/>pair auth, virtual streams, credit"]
    lifecycle["Workspace lifecycle (workspace-lifecycle.ts)<br/>start, stop, restart, generations"]
    registry["Registry (fleet-state.json)<br/>roster, projects, enrollment digests"]
  end

  uiproc["omp-web ui (split form)<br/>static UI, HTTP proxy,<br/>/callback/ws forwarder"]

  subgraph runtimes["Session runtimes (host process, bwrap, kubernetes)"]
    subgraph sess["omp-web session"]
      cb["Callback client (fleet-callback.ts)<br/>dial, send gates, redial"]
      dc["Daemon control (daemon-control.ts)<br/>virtual streams, replay ring, pacing"]
      sdk["SDK agent session<br/>(sse-delivery.ts slims events)"]
    end
  end

  model["Model provider"]
  jsonl[("session .jsonl transcript")]

  ui -- "GET /events (SSE)" --> edge
  ui -- "POST /command (202)" --> edge
  ui -.-> uiproc
  uiproc -.-> edge
  edge <--> transport
  lifecycle --> registry
  lifecycle -- "spawn<br/>(stdin payload)" --> sess
  cb -- "WebSocket GET /callback/ws<br/>(session dials out)" --> transport
  cb -- "POST /callback/bulk/id" --> transport
  cb -.-> uiproc
  cb <--> dc
  dc <--> sdk
  sdk <--> model
  sdk --> jsonl
```

- **The fleet never dials a session.** Every session dials out to `/callback/ws` with its workspace id, generation, connection id, credential and protocol version in the upgrade headers. That way a session can run on the fleet host, in a bwrap sandbox, or in a pod behind NAT. In the split form (`omp-web ui` in front of `omp-web control`), the UI process forwards both the browser routes and the session WebSocket to the control plane on loopback.
- **Each launch gets a fresh credential.** The lifecycle mints a new credential and generation for every launch and passes them on stdin (`--fleet-stdin`), never in argv or the environment. The fleet stores only the credential's digest. A refused dial is upgraded and then closed with a typed code (4000 + HTTP status). The session stops for good on `unauthorized`, `invalid_identity`, `generation_obsolete` or `proto_unsupported`, and redials on anything else.
- **Virtual streams multiplex one pair.** `transport` carries the fleet's own controls (`pair_ready`, `pair_credit`, heartbeats). `control` carries the session's state mirror, which the fleet taps for roster activity. Each attached browser gets its own `browser/<connId>` stream.
- **The session primes every stream it is asked to open.** The edge relays those frames to the browser's SSE stream, stamping `sessionId`. Answers to commands go only to the browser that sent them.

## One session's life over time

This is a sequence diagram. Arrows between the edge and the session travel over the pair, through the fleet transport. The transport is drawn only where it acts on its own: pairing, credit and heartbeats.

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser
  participant E as Fleet edge
  participant T as Fleet transport
  participant S as Session
  participant M as SDK and model

  rect rgba(128,128,128,0.08)
  Note over T,S: Launch and pair
  T->>S: spawn omp-web session, stdin payload (callback URL, credential, workspace, generation)
  S->>T: GET /callback/ws upgrade (identity + credential headers, x-omp-callback-proto 2)
  T-->>S: 101, then pair_ready on stream "transport"
  S->>T: state on stream "control" (lastSessionFile, activity)
  end

  rect rgba(128,128,128,0.08)
  Note over B,E: Browser connects and attaches
  B->>E: GET /events?client=id (SSE)
  E-->>B: roster, daemons, projects (priming)
  B->>E: POST /command attach
  E-->>B: 202 accepted
  E->>S: stream_open (lastSeq, ack) on browser/connId
  E-->>B: attach_result (id-keyed)
  S->>E: hello_ok, attached, history chunks, state, available_commands, ready
  E-->>B: SSE events (sessionId stamped)
  E->>S: stream_ack as the browser's queue drains (at most 3 MiB unacked per stream)
  T->>S: pair_credit every 512 KiB consumed (at most 8 MiB in flight per pair)
  end

  rect rgba(128,128,128,0.08)
  Note over B,M: Prompt
  B->>E: POST /command call prompt (id)
  E-->>B: 202 accepted
  E->>S: command on browser/connId
  S->>M: prompt
  M-->>S: streamed tokens, tool calls
  S->>E: event frames (message_update deltas, tool_execution_update appends)
  E-->>B: SSE events (ringed for Last-Event-ID resume)
  S->>E: call_result (id)
  E-->>B: call_result, to the originating browser only
  S->>T: state on "control" (streaming, blocked)
  E-->>B: daemon_activity (on change)
  end

  rect rgba(128,128,128,0.08)
  Note over B,S: Idle, drops and recovery
  S->>T: heartbeat every 15 s while idle (both directions, 30 s silence deadline)
  Note over B,E: SSE drop: browser reconnects<br/>with Last-Event-ID, edge replays its ring
  Note over T,S: Pair drop: session redials (backoff 1 s to 30 s).<br/>Roster shows reconnecting after 5 s. Browser streams<br/>end with "daemon connection lost" and re-attach.
  Note over T,S: Crash: lifecycle revokes the generation, backs off,<br/>restarts with generation + 1 and --resume
  end
```

## Flow control

Three bounds keep any slow party from holding unbounded memory elsewhere:

| Bound | Size | Who enforces it | Effect |
|---|---|---|---|
| Socket send high-water mark | 1 MiB | Each sender | No more messages go to the socket while its buffer is above this. The rest waits in the sender's bounded queue (8 MiB per pair, 4 MiB per stream). |
| Pair credit window | 8 MiB | Fleet grants `pair_credit` as it consumes | A session never has more than 8 MiB on the wire unconsumed. The fleet closes a pair that exceeds it. This also bounds what `omp-web ui` or a reverse proxy holds for one pair. |
| Stream ack window | 3 MiB | Edge sends `stream_ack` as the browser's queue drains | History priming is paced by the slowest reader on that stream only. A browser with no drain for 30 s is dropped and resumes with Last-Event-ID. |

## Where to read next

- `lib/wire/protocol.ts` and `lib/wire/callback-protocol.ts`: frame and envelope shapes, constants, and the header comments that define each hop.
- `apps/fleet/edge.ts`: browser routing, priming, ring and backpressure rules.
- `apps/fleet/daemon-transport.ts` and `apps/session/fleet-callback.ts`: the two halves of the pair.
- `docs/provider-protocol.md`: how runtime providers launch clones that dial this pair.
- `scripts/profile/results/`: measurements behind the transport choices.
