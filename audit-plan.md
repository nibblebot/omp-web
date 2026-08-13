# omp-web — Audit Remediation Plan

Companion to the 2026-08-12 full audit. Finding numbers (`#N`) reference the report (`audit.html`, removed 2026-08-13 after phases 0–6 shipped). Severity order within each phase. Each phase is independently shippable; phases 0–1 were correctness fires, phases 2–5 hardening, phase 6 docs/dead code. The strategic Phase 7 items moved to [`docs/position.md`](docs/position.md).

## Phase 0 — Baseline hygiene (do first, blocks reliable verification)

- [x] Run `bun install` so `check:types` works (`tsgo` missing at audit time)
- [x] Triage the 25 failing + 10 erroring tests (concentrated in `fleet/integration.test.ts` — real-daemon integration failures); either fix or mark known-broken with tracking issues
- [x] Land `bun run check:types` + `bun test` green as the merge gate before any phase below

## Phase 1 — Correctness & security fires (critical/high)

- [x] **#19 (critical)** Shell-escape `{cwd}`/`{name}`/`{labels}`/`{resume}` substitutions in fleet spawn templates (`fleet/supervisor.ts` + `spawn-parse.ts`); add injection regression tests
- [x] **#10 (high)** Fix collab bus frames broadcasting twice to every guest (`server/collab-host.ts` channel loop)
- [x] **#11 (high)** Chunk or cap history priming so >4 MiB sessions stay attachable; make backpressure-kill recoverable instead of permanent
- [x] **#20 (high)** Serialize `supervisor.respawn()` (per-daemon respawn mutex) to stop double-launches/orphan processes
- [x] **#27 (high)** Fix `getSubagents` on daemon switch being rejected by `rejectPendingCalls` (`src/state.ts` ordering)
- [x] **#32 (high)** Make AskDialog select/ask options keyboard-reachable inside Modal's focus trap

## Phase 2 — Stream lifecycle & daemon reliability (the reconnect cluster)

Several findings share root causes in SSE resume/reconnect handling; fix as one effort with integration tests that kill streams mid-priming, mid-history, and mid-answer.

- [x] **#0** Distinguish backpressure stream-kill from dormant close so the connector doesn't mark live daemons `asleep`
- [x] **#1** Arm the connector idle-drop for never-attached daemons (or add a spawn-time TTL)
- [x] **#2** De-dupe SSE resume: fresh history priming + ring replay must not double-apply deltas
- [x] **#3** Reconcile registry statuses at fleet boot (redial or mark stale entries)
- [x] **#4** Give the edge browser→daemon pipe a resume path so one dropped stream doesn't permanently detach the browser
- [x] **#21** Fan-out correlation: match `agent_end`/`error` to the fanned-out turn, not any concurrent turn on the daemon
- [x] **#22** Reset the supervisor restart budget on sustained health (window-based, not lifetime)
- [x] **#23** Handle malformed wrapper endpoint URLs without killing the stdout pump / wedging `spawning`
- [x] **#12** Auth-gate relay room creation off-loopback; cap room count
- [x] **#28** Don't reject an in-flight attach on unrelated global error frames
- [x] **#29** Reconcile bang-shell/python 30s client timeout with server-side completion (keep result retrievable)

## Phase 3 — Protocol & interface hygiene

- [x] **#59** Answer failed unattached `call`s with a `call_result` error payload (not a bare `error` frame) so client promises don't hang 30s
- [x] **#61** Validate `hello_ok.proto` browser-side; check OMP_PROTO at the edge, not only fleet↔session
- [x] **#60/#68** Remove or implement `process_stats`/`get_process_stats` dead wire surface
- [x] **#62/#69** Remove dead `attached.mode: "multi"` variant; document the `collab_status` priming frame
- [x] **#63** Make edge allowlists exhaustiveness-safe for added protocol variants (compile-time assert, not silent mishandling)
- [x] **#51** Single-source the daemon merge key (currently duplicated across four sites in three layers)
- [x] **#53** Export the `OMP_SESSION|` prefix from `protocol.ts` (hardcoded in five sites)
- [x] **#9** Fix the contract line advertising `ws://` for a plain-HTTP SSE endpoint
- [x] **#16** Don't replay answered/expired `ui_request` frames from the SSE ring on reconnect
- [x] **#31** Add a timeout to `attachSession()`
- [x] **#25** Close the previous stream on `clientId` rebind
- [x] **#14** Make bearer-token comparison consistently case-sensitive across header and `?token=`
- [x] **#13** Tighten `isLoopbackHost` to real loopback ranges
- [x] **#15** Validate numeric settings before persist (reject NaN)

## Phase 4 — Frontend components & accessibility

- [x] **#33/#42** One keyboard-accessible row pattern for all pickers (button semantics, focus, Enter/Space)
- [x] **#43** Expose the message hover toolbar to keyboard focus and touch
- [x] **#36** Modal: restore focus on close, label the dialog (`aria-label`/`aria-labelledby`)
- [x] **#34** Redraw CharacterAvatar when the model resolves (reactivity, not mount-only)
- [x] **#35** Fix ToolShell reactive `open` binding clobbering manual `<details>` toggles
- [x] **#37** Extract the collapsed-output logic (three copies, inconsistent limits/copy) into one helper
- [x] **#38** Scope TaskTool cards to their own subagent list, not the session-global roster
- [x] **#30** Merge `subagent_progress` placeholders on lifecycle frame arrival
- [x] **#39** Move SubagentRow out of the tool-card module; honor ToolShell `meta` in all branches
- [x] **#40** Move the assistant copy button into the hover toolbar pattern

## Phase 5 — Design system hardening

- [x] **#41** Raise `--muted-2` to WCAG AA contrast in the default dark theme
- [x] **#44** Actually load Inter/JetBrains Mono (or drop the names and embrace system fonts deliberately)
- [x] **#45** Widen the type scale — fs-sm/md/lg ~1px apart gives no hierarchy
- [x] **#47** Responsive pass: fluid sidebar, popover min-widths that fit small viewports
- [x] **#48** Token discipline: dedupe `.amount-bar`, replace scattered hardcoded px with tokens
- [x] **#49** Fix Catppuccin surface-elevation inversion (panel darker than page)
- [x] **#46** Add a legend to the context-breakdown bar; use neutral colors for neutral categories
- [x] **#50** Theme-aware boot background in `index.html` (kill the dark flash for light users)

## Phase 6 — Docs, organization & dead code

- [x] **#67** Quickstart: add the model-provider/auth prerequisite (the step that determines whether anything works)
- [x] **#64** README: remove the collab-in-web-UI promise or implement the surface (client has no collab UI)
- [x] **#65** README: correct "71-method dispatch table" → actual count (58); automate or drop the number
- [x] **#66/#58** README: fix sidebar-mode claim; add the missing `remove` CLI subcommand
- [x] **#70** Pick one term — "sessions" vs "daemons" — for UI copy
- [x] **#56/#68** Archive `SSE-plan.md` (completed plan) into `docs/` or delete; fix its divergences from shipped behavior
- [x] **#57** Move `protocol.ts`/`sse.ts` out of the client `src/` tree into a shared location (imported by all three layers)
- [x] **#54** Delete dead sprite exports/imports
- [x] **#55** Align test filenames with module names; add a `state.ts` test
- [x] **#52** Fix stale `spawn.ts` comment in `fleet/config.ts`
- [x] **#17** collab-cli: distinguish collab_start failures from unrelated global error frames
- [x] **#26** CLI: implement or remove `--fan-out`; stop silently dropping `-`-prefixed flag values
- [x] **#18** Remove vestigial WS-era SocketData variant and dead RING_DELTAS entry
- [x] **#24** Clean up supervisor/connector per-daemon state on removal; settle hanging waiters
- [x] **#5/#8** Bound edge per-client rings (full-history/large frames); consider shared fan-out instead of N+1 pipes
- [x] **#6/#7** Longer-term: split `server/index.ts` (~91 KB, ~8 subsystems incl. the hub control surface) along its natural boundaries; derive edge's session-frame list from the protocol union

## Phase 7 — Product & positioning (strategic)

Moved to [`docs/position.md`](docs/position.md) — the full positioning case (#71/#72), open strategic items (#73–#80), and strengths to preserve.
