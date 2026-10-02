# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Solo operator running parallel agents: one developer spawning, supervising, and steering many concurrent omp agent sessions across local projects, git worktrees, and remote sandboxes. Multi-user is an open strategic question (audit #74), not a current audience.

## Product Purpose

Two coupled products around one Solid.js web UI:

- **omp-session**: the session daemon for `@oh-my-pi/pi-coding-agent`: one process, one bound project directory, one live agent session (in-process SDK, no child process, no JSON-RPC hop), served over SSE + POST. Runs via the installed omp-web bundle (`omp-web session`); disposable: disk `.jsonl` logs make respawn/`--resume` lossless.
- **omp-fleet**: the registry of N daemons: spawns and supervises local children from command templates, attaches external daemons, dials remote sandboxes, and serves them to the web UI (the only web UI server) and to non-interactive drivers (CLI fan-out prompting). Holds zero SDK state.

Success means the operator can watch, steer, and fan out across many agent sessions from one browser surface without losing a session to process death.

## Positioning

Two differentiators, both user-confirmed:

1. **Fleet ops moat**: single binary, in-process SDK, dial-in-by-default sandboxes, disposable daemons. Self-hosted fleet operations that incumbent chat surfaces don't play in (audit #72).
2. **Full web UI parity with the TUI**: settings panel at `/settings` parity, steering, queue chips, rich tool cards, subagent roster, session resume/branch/fork/handoff. The browser surface is not a reduced companion.

## Operating Context

- The operator runs `bun run dev` (vite HMR + the fleet, ports picked per run; `bun run fleet serve` defaults the control plane to 4722, and session daemons take an ephemeral port under the shipped local template, with 4721 the daemon's own default when started by hand).
- Daemons are spawned from user-editable command templates (`~/.omp-web/config.json`); remote daemons reached via ssh `-L`, tailnet, or direct.
- Remote sessions are dial-in by default: omp-fleet initiates every connection and sandbox images know nothing of the external world. Managed clone workspaces are the exception: a clone's session daemon has no inbound service and dials the fleet's callback pair outbound. (Documented security model: factual behavior, not currently pinned as an inviolable constraint; see Capabilities and Constraints.)
- Collab rooms exist but are CLI/TUI-only; there is deliberately no collab surface in the web UI.

## Capabilities and Constraints

- One app: the fleet-served roster UI with project-grouped rows (per-row branch + dirty counts, status dots); clone rows carry a kind chip, a provider-profile chip, and a provider lifecycle stage line.
- Clone workspaces: provider-managed sessions (sandboxed `bwrap` or Kubernetes) created from the unified Add-workspace dialog (Worktree / Clone / Add existing) under a declared provider profile, with stop/wake lifecycle and deletion only through the verified gate. The fleet owns the clone lifecycle service, the durable log store, and the read-only stored-session API.
- Browser auth: an operator access token (config `browserAccessToken`, kept only as its sha-256 digest) gates non-loopback browsers through `/auth/login`, an HttpOnly session cookie, and an Origin/CSRF check on mutations; a non-loopback bind without it refuses to start.
- Stored sessions: the fleet mirrors every managed daemon's session lineage into its log store and serves read-only browsing in the Analysis view (workspace and session lists, parsed or raw transcripts, `#/stored/<workspaceId>/<sessionId>` deep links); a deleted workspace is view-only, with resume-onto-fresh-clone as its only resume action.
- Fleet-required notice: the web UI is served only by the fleet; pointed at a bare session daemon the client renders a full-screen notice instead of the shell.
- Wire protocol: SSE + POST only on the agent path; `lib/wire/protocol.ts` is the shared contract, additive changes only, `OMP_PROTO` (currently 2) gates drift.
- Stack: Bun runtime, Solid.js 1.9, Vite, TypeScript. The fleet ships inside the `dist-bundle/cli.js` bundle; there is no separate compiled omp-fleet binary yet (audit #75 open).
- **Constraints: none pinned for now** (user answer, 2026-08-13). The documented security model (loopback-trusted UI, bearer token off-loopback, a browser access token plus Origin/CSRF session for non-loopback browsers, dial-in-by-default remotes, `/download` realpath jail) is factual current behavior but was explicitly not elevated to a binding constraint.
- Open strategic decisions (audit Phase 7): multi-user/auth (#74), fan-out prompting in the roster UI (#73), fleet binary (#75), remote TLS story (#78), mobile/companion surface (#77).

## Brand Commitments

- Names: **omp-session**, **omp-fleet**; part of the **oh-my-pi** (`@oh-my-pi/pi-coding-agent`) ecosystem. The product ceiling is coupled to omp agent adoption (audit #79).
- UI copy uses **"daemons"** for session processes and **"workspaces"** for the roster entries that hold them (worktrees and provider-run clone workspaces); audit #70 settled sessions-vs-daemons.

## Evidence on Hand

- `README.md`: full architecture, security model, config surface.
- `docs/position.md` (2026-08-13): audit Phase 7 strategic items (findings #71–#80). The full report (`audit.html`) was removed 2026-08-13 and the remediation plan (`audit-plan.md`) archived 2026-08-15; remediation history survives as `finding #N` comments in code. This directory (`omp-fleet.design-audit`) is the design-audit worktree.
- No testimonials, customers, benchmarks, or marketing claims exist; future work must not fabricate them.

## Product Principles

1. **One operator, many agents**: every surface decision optimizes for supervising N concurrent sessions, not one conversation.
2. **Fleet operations are the moat**: spawn, attach, dial-in, respawn, fan-out; the chat surface is table stakes.
3. **Parity, not companion**: the web UI matches TUI capability; reduced surfaces are regressions.
4. **Disposability**: daemons die and resume from `.jsonl`; no UI state may assume process permanence.
5. **Additive wire contract**: protocol evolves by addition; breaking the handshake is a versioned, deliberate event.
