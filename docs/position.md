# omp-web — Product positioning

Extracted 2026-08-13 from the 2026-08-12 full audit (`audit.html`, since removed; remediation history in `audit-plan.md`). Finding numbers (`#N`) are the audit's, kept for traceability. These are the audit's Phase 7 strategic items — the only unfinished phase.

## The core call (#71, #72 — both HIGH, verified)

**Stop positioning omp-web as "a web UI for a CLI agent."** That surface is now a default feature of incumbents: Claude Code ships `claude agents` (full-screen session dashboard), claude.ai/code (fleet sessions in Anthropic VMs, cloud persistence, resume-from-any-device), and Managed Agents orchestration; VS Code and OpenHands cover the same ground at the IDE level. The claim is absorbed at both the terminal and IDE layer.

**Lead with the ops/security moat — the properties no competitor combines:**

- **In-process SDK** — `createAgentSession` runs in the daemon process; no child process, no JSON-RPC hop (contrast: Claude Agent SDK spawns the CLI as a subprocess over stdin/stdout).
- **Single self-contained binary** — `build:omp-session` embeds UI + native addons; copy the binary to any host and run.
- **Dial-in-only sandboxes** — omp-session never dials out; per-daemon tokens minted at boot; a sandbox image contains zero knowledge of the fleet.
- **Disposable daemons** — idle auto-exit → `asleep` → respawn-on-demand with `--resume` and a fresh token per attempt (proven end-to-end by SIGKILL recovery in `fleet/integration.test.ts`).

Frame: *self-hosted agent infrastructure — your agents, your infra, disposable by design. The web UI is the control plane of that system, not the product.* README and docs should lead with the deployment/security story; it is the only place competitors cannot follow without abandoning their cloud/IDE architectures.

## Open strategic items

- [ ] **#73 — Fan-out prompting in the roster UI.** The headline fleet capability is CLI-only (`omp-fleet prompt <selector> --fan-out`, correlation machinery in `fleet/fanout.ts`); the browser has no multi-select or prompt-many affordance (`fleet/edge.ts` proxies single-session commands only). Meanwhile the market's showcased multi-agent story is parallel dispatch (Cursor background agents, Claude Managed Agents). Add selector-driven fan-out: multi-select or label/project selector, a prompt box, per-session result panel (final text + usage). This turns the roster from a viewing surface into the control plane the fleet story promises.
- [ ] **#74 — Multi-user/auth roadmap.** Single-operator v1 is honest, but it caps adoption at exactly the segment competitors win: team/enterprise control centers with identity, audit, and cost guardrails (OpenHands Agent Canvas ships these). Next step with teeth: bearer token on the fleet edge plus per-user access scoping, reusing the daemon's existing OAuth machinery.
- [ ] **#75 — omp-fleet compiled binary.** "Single binary self-hosted" is half true while the differentiator itself needs a checkout + Bun runtime. Add `build:omp-fleet` (bun compile over `fleet/`, ~6 small modules) → `dist-bin/omp-fleet`, plus a systemd unit and container example.
- [ ] **#76 — Fleet-level usage/cost aggregation.** Per-session usage exists (`UsagePanel`); the roster serializes none of it, while competitors headline usage visibility and cost guardrails. Aggregate in the edge (the connector already observes `agent_end` with usage): per-session token/cost column + fleet total in the roster header. Counters the "runaway parallel agents" objection.
- [ ] **#77 — Mobile/companion surface.** No PWA manifest, no touch handling; Codex already ships mobile remote control while Cursor has none. The SSE web architecture makes "check on my fleet from my phone" a cheap win — the exact use case for dial-in daemons running overnight on a VM, and a wedge Electron-desktop and cloud-VM competitors can't match with a URL.
- [ ] **#78 — Close the remote story.** No `wss://`, no token rotation (provisioned sandboxes keep one token for the daemon's lifetime), cross-device continuity is manual ssh dial-in — while competitors headline cloud persistence and resume-from-any-device. Ship a rotate-token control-plane route (reuse the respawn path that already mints fresh tokens) and document TLS termination in a runbook.
- [ ] **#79 — Ecosystem coupling risk (LOW).** The ceiling is omp (oh-my-pi) agent adoption (~23.7k stars, ~65k weekly SDK downloads vs OpenCode 100k+, OpenHands ~80k + Series A). The winning self-hosted pattern is agent-agnostic aggregation. Keep `OMP_PROTO` (additive-only) as the seam for future agent-agnostic adapters — the protocol discipline already in place is the cheap insurance.
- [ ] **#80 — Promote collab guest rooms (INFO).** Link-based live session sharing with no identity burden (`bun run collab`, E2E room key in the link, `OMP_SESSION_COLLAB_MAX_GUESTS` 64) ships today and no mainstream incumbent matches it — they add named collaborators or nothing. Lead the single-session collaboration story with "share a live agent session with a link — no account required"; make the join flow a documented, polished first-class surface.

## Strengths to preserve

- Security model is genuinely differentiated and carefully executed: dial-in-only topology, per-daemon tokens, roster serialization that never leaks tokens/endpoints to browsers, loopback-exempt bearer auth, `hello_ok.cwd` sanity check against stale endpoints, realpath-jailed `/download`.
- `OMP_PROTO` gating with additive-only contract changes is clean evolution discipline for a distributed fleet.
- Single-session UI depth is unusual for a web companion: near-full TUI dispatch parity (subagent drill-down, queue/steer, branch/fork/handoff, `/btw`, `/export`), not a thin chat wrapper.
- Fan-out prompting with per-session correlation plus label/project selectors exists nowhere else in the self-hosted space.
- Minimal dependency footprint (solid-js + marked/dompurify/diff) with the UI embedded in the binary gives the deploy story real substance.
- Roster ergonomics match the git-worktree workflow the parallel-agent crowd actually uses: repo-grouped sessions, worktree rows by branch, porcelain dirty counts.
