# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Solo operator running parallel agents: one developer spawning, supervising, and steering many concurrent omp agent sessions across local projects, git worktrees, and remote sandboxes. Multi-user is an open strategic question (audit #74), not a current audience.

## Product Purpose

Two coupled products sharing one Solid.js web UI:

- **omp-session** — a single-session agent daemon for `@oh-my-pi/pi-coding-agent`: one process, one bound project directory, one live agent session (in-process SDK, no child process, no JSON-RPC hop), served to the web UI over SSE + POST. Ships as a self-contained binary; disposable — disk `.jsonl` logs make respawn/`--resume` lossless.
- **omp-fleet** — the registry of N daemons: spawns and supervises local children from command templates, attaches external daemons, dials remote sandboxes, and re-exposes them to the same UI (roster mode) and to non-interactive drivers (CLI fan-out prompting). Holds zero SDK state.

Success means the operator can watch, steer, and fan out across many agent sessions from one browser surface without losing a session to process death.

## Positioning

Two simultaneous differentiators, both user-confirmed:

1. **Fleet ops moat** — single binary, in-process SDK, dial-in-only sandboxes, disposable daemons. Self-hosted fleet operations that incumbent chat surfaces don't play in (audit #72).
2. **Full web UI parity with the TUI** — settings panel at `/settings` parity, steering, queue chips, rich tool cards, subagent roster, session resume/branch/fork/handoff — the browser surface is not a reduced companion.

## Operating Context

- The operator runs `bun run dev` (fleet roster, vite :4713 + fleet :4722) or `bun run dev:single` (standalone daemon :4721).
- Daemons are spawned from user-editable command templates (`~/.omp/fleet/config.json`); remote daemons reached via ssh `-L`, tailnet, or direct.
- Remote sessions are dial-in only: omp-fleet initiates every connection; sandbox images know nothing of the outside world. (Documented security model — factual behavior, not currently pinned as an inviolable constraint; see Capabilities and Constraints.)
- Collab rooms exist but are CLI/TUI-only; there is deliberately no collab surface in the web UI.

## Capabilities and Constraints

- One app, two modes: standalone (single-session UI, no sidebar) and roster (fleet sidebar, repo-grouped daemon rows, per-row branch + dirty counts, status dots).
- Wire protocol: SSE + POST only on the agent path; `shared/protocol.ts` is the shared contract, additive changes only, `OMP_PROTO` (currently 2) gates drift.
- Stack: Bun runtime, Solid.js 1.9, Vite, TypeScript. No compiled omp-fleet binary yet (runs from a checkout; audit #75).
- **Constraints: none pinned for now** (user answer, 2026-08-13). The documented security model (loopback-trusted UI, bearer token off-loopback, dial-in-only remotes, `/download` realpath jail) is factual current behavior but was explicitly not elevated to a binding constraint.
- Open strategic decisions (audit Phase 7): multi-user/auth (#74), fan-out prompting in the roster UI (#73), fleet binary (#75), remote TLS story (#78), mobile/companion surface (#77).

## Brand Commitments

- Names: **omp-session**, **omp-fleet**; part of the **oh-my-pi** (`@oh-my-pi/pi-coding-agent`) ecosystem. The product ceiling is coupled to omp agent adoption (audit #79).
- UI copy uses **"daemons"** as the roster term (audit #70 settled sessions-vs-daemons).

## Evidence on Hand

- `README.md` — full architecture, security model, config surface, roadmap.
- `docs/position.md` (2026-08-13) — audit Phase 7 strategic items (findings #71–#80). The full report (`audit.html`) was removed 2026-08-13 and the remediation plan (`audit-plan.md`) archived 2026-08-15; remediation history survives as `finding #N` comments in code. This directory (`omp-fleet.design-audit`) is the design-audit worktree.
- `fleet/examples/` — copy-pasteable spawn template examples (ssh-remote, docker, provider-skeleton).
- No testimonials, customers, benchmarks, or marketing claims exist; future work must not fabricate them.

## Product Principles

1. **One operator, many agents** — every surface decision optimizes for supervising N concurrent sessions, not one conversation.
2. **Fleet operations are the moat** — spawn, attach, dial-in, respawn, fan-out; the chat surface is table stakes.
3. **Parity, not companion** — the web UI matches TUI capability; reduced surfaces are regressions.
4. **Disposability** — daemons die and resume from `.jsonl`; no UI state may assume process permanence.
5. **Additive wire contract** — protocol evolves by addition; breaking the handshake is a versioned, deliberate event.
