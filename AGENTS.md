# AGENTS.md

Repository guardrails. README.md is user documentation; source types define precise contracts.

## What this repo is

Bun, TypeScript ESM, Solid.js. `omp-session` runs one in-process SDK session per daemon, bound to an immutable project directory. Durable agent truth lives in session `.jsonl` logs. `omp-fleet` supervises daemons and alone serves the UI. It holds no agent state; persistence is roster metadata, private clone workspace records, and the fleet log store. The browser has one shared store and no router.

## Commands

```sh
bun install
bun run dev                         # Vite HMR + fleet
bun run check:types                  # tsgo, not tsc
bun run lint                        # library boundaries + oxlint
bun run format                      # oxfmt, TS/TSX only
bun run format:check
bun scripts/test.ts <test-file>      # targeted tests
bun run test
bun run build:web
bun run build                       # installable bundle
bun e2e/onboarding.ts                # offline distribution E2E
```

Open dev's printed `ui` URL, not fleet's potentially stale `dist/` UI. Restart dev-spawned daemons after server edits; they are not watched. Broker management is opt-in via `bun run dev --auth-broker`; default dev and production never manage broker startup or automatically configure credentials.

## Repo layout

| Path | Ownership |
| --- | --- |
| `apps/cli/` | Installed entrypoint, update, collab CLI |
| `apps/session/` | Session daemon, dispatch, SSE delivery, callback/log mirroring |
| `apps/fleet/` | Registry, supervision, connector, browser edge, control API, stats, clone lifecycle |
| `apps/web/` | `state.ts` facade, actions in `store/`, feature logic, presentational `components/` |
| `lib/` | Closed wire/runtime/session-files/sdk-settings/platform/testkit libraries |
| `apps/*/test/`, `lib/*/test/`, `scripts/test/`, `e2e/` | Owner-local tests and cross-app/distribution checks |
| `scripts/`, `docs/release.md` | Tooling and release contracts |

Production source is flat in cli/fleet/session; preserve the web feature hierarchy.

## The wire contract (OMP_PROTO 2)

Agent transport is HTTP + SSE, not WebSocket (collab-only). `POST /command` accepts ID-keyed commands with `202`; answers arrive via SSE `call_result`. `lib/wire/protocol.ts` owns shapes/constants. Fleet stamps session identity; a bare-daemon browser connection must show the fleet-required notice.

## Invariants & conventions, read before editing

### Protocol (`lib/wire/`)

- Changes are additive-only unless `OMP_PROTO` is bumped with both fleet gates (`connector.ts`, `edge.ts`).
- Preserve byte-bounded history, chunk accumulation, and replay/backpressure semantics. `stream_reset` ends a stream, not the daemon. Do not clip messages merely because they exceed the frame batch target.
- Command retries reuse the same ID within the dedup window. Duplicates replay answers, never re-dispatch; replay across daemon process changes must fail, never execute again.

### Server

- Daemon stdout is reserved for `OMP_SESSION|` contract lines; logs go to stderr.
- Preserve `methods.ts` classification: read-only calls skip mutation broadcasts, history reloads resync before answers, prompts are readiness-gated.
- Loopback auth exemption does not extend off-loopback: binding without a token fails startup; wrong credentials return 401.
- Callback transport requires workspace/generation identity and HTTPS, except explicitly allowed loopback HTTP. Configured proxies must be http/https, never silently ignored.
- Downloads stay realpath-jailed; file listings stay inside cwd. Idle exit requires no clients or active work, tools, dialogs, or collab room.

### Fleet

- Keep static fleet loading SDK-free; exceptional SDK access uses lazy imports.
- Mint tokens per spawn/restart. Never expose tokens, private workspace records, enrollment digests, or secret values in roster/debug/public profiles; debug snapshots must not expose daemon endpoints.
- Answers go only to the originating browser. Disconnects and origin-map caps must not discard outstanding replay protection. Reject replays when daemon PID, endpoint, or credentials change.
- Fleet/session files use exclusive lifetime locks. Session-lock exit 77 must not restart; fail waiting attaches and return the entry to asleep.
- Registry writes are atomic; project/daemon IDs are monotonic, never reused. Validate explicit resume files against the owning worktree's listing, never arbitrary paths.
- Worktree deletion requires managed ownership and a clean tree. No force; branch deletion uses `git branch -d`, never `-D`. Transcripts survive worktree deletion.
- Clone operations go through `workspace-lifecycle.ts`, never handler self-fetches. Persist retry-sensitive state before provider steps; prove predecessor termination before replacement, never PID-only.
- Clone stop preserves checkout/logs. Deletion requires proven stop, Git guards, transcript-store verification against the volume, and read-only protection before provider/volume removal. No force bypass; transcripts are not source backup.
- Resume restores the requested durable session or fails explicitly, never silently boots fresh or substitutes upstream source. Stored-history reads never wake compute; retention/purge is explicit, not automatic GC.
- Remote entries are dial-in-only, never locally Git-probed; clones are the outbound callback exception. Sandboxes never mount operator agent state.
- Template substitutions require caller shell escaping. Config loading stays read-only; preserve the TTY-only first-run writer.

### Frontend (`apps/web/`)

- One `createStore` in `state.ts`; components mutate shared data only through exported actions.
- Markdown always uses `DOMPurify.sanitize(marked.parse(...))`; model HTML is untrusted.
- Mutate streaming blocks in place; replacing objects remounts Solid `<For>` and breaks scrolling/fades.
- Preserve stale-session guards and replay dedup. Session switches reject pending calls/reset IDs without clearing fleet-scoped data.
- Preserve global CSS import order and shared design tokens; theme palettes override variables only. No CSS modules; avoid inline styles.

### Tests

- Run through `scripts/test.ts` from repo root; no live model/API dependency. Do not add retries or suppress failures.
- Capture full-suite output in a log, not a truncated pipe.
- Scratch dirs use tracked `tempDir()` from `lib/testkit/temp-dir.testkit.ts`, never raw mkdtemp. Helpers use `*.testkit.ts` to avoid discovery.
- `apps/session/test/collab-relay.test.ts` intentionally omits `server.stop()`: Bun hangs closing sockets with close codes.

### Style

- Tabs, `import type`, tsgo, oxlint, oxfmt. Markdown/CSS/HTML/JSON stay hand-maintained.
- Shared imports use extensionless `#lib/...`; local imports stay relative. Root package owns the mapping. Imports from `lib/` stay within `lib/`, with no cycles.
- Git identity comes only from the user's `.gitconfig`; never set/override it. Missing identity means stop and report.
- **SDK pins**: the seven `@oh-my-pi/*` packages (`pi-agent-core`, `pi-ai`, `pi-catalog`, `pi-coding-agent`, `pi-tui`, `pi-utils`, `pi-wire`) are pinned exactly (18.8.6), without dependency patches. Bump together; never hand-edit `node_modules`. Fresh installs have no root `patchedDependencies` entry for `pi-agent-core`; prefixes installed by releases up to 0.2.0 retain that legacy entry until manually removed (see `docs/src/content/docs/operations/updates.md`). Install and update do not remove it. Clean-prefix SDK behavior comes from the pinned upstream version.
- `apps/fleet/embedded-dist.ts` is a checked-in `{}` stub; build regenerates/restores it. Never hand-edit generated imports. Install into the pinned prefix, not a shared global SDK store.
- Preserve `finding #N` audit numbering. Keep affected docs current. Prose uses no em dashes; numeric-range en dashes are fine.

## Editing workflows

Update wire contracts, producers, consumers, dispatch classification, and behavior tests together. For bugs, reproduce before fixing and confirm afterward. Read the affected implementation rather than treating this file as a complete specification.

## Verification

- Code: targeted tests, then types. Library/daemon/edge changes also require the full suite.
- UI: `bun run dev`, verify the actual browser surface, including fleet-required handling when relevant.
- CLI/distribution/bundle/first-run: `bun e2e/onboarding.ts`.
- Docs: check paths/links.
- Release: `GATE_COMMANDS` in `scripts/release.ts` is authoritative; includes types, format, web build, full tests, onboarding, followed by packed-artifact installation smoke. Preflight is advisory, not part of orchestration.
