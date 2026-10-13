# AGENTS.md

Repository guardrails. README.md is user documentation; source types define precise contracts.

## What this repo is

Bun, TypeScript ESM, Solid.js. `omp-session` runs one in-process SDK session per daemon, bound to an immutable project directory. Durable agent truth lives in session `.jsonl` logs. `omp-web` (`apps/fleet`) supervises daemons and serves the UI: bare `omp-web` runs control plane and UI on one port, `omp-web control` runs the control plane alone, and `omp-web ui` serves the UI and proxies its API to a control plane. It holds no agent state; persistence is roster metadata, private clone workspace records, and the fleet log store. The browser has one shared store and no router.

## Commands

### Dev

```sh
bun install
bun run dev                         # Vite HMR + fleet
bun run format                      # oxfmt, TS/TSX only
bun run design                      # component stories (own Bun server, real apps/web components)
bun run demo                        # App demo with fixture data (own Bun server)
bun run dev:docs                    # Astro dev server for docs/
```

Open dev's printed `ui` URL, not fleet's potentially stale `dist/` UI. Dev-spawned daemons run with a 2s `--control-grace` (`DEV_SESSION_CONTROL_GRACE` in `scripts/dev.ts`; production keeps 10m), so they exit about 2s after dev stops, by any means; a dev restart within that window lets them redial the stable per-worktree fleet port. Restart them after server edits (stop them from the UI, or restart dev and wait out the grace); they are not watched. Broker management is opt-in via `bun run dev --auth-broker`; default dev and production never manage broker startup or automatically configure credentials.

### Checks

```sh
bun run check                       # types + lint + format:check + full suite
bun run check:types                 # tsgo, not tsc
bun run lint                        # library boundaries + oxlint
bun run format:check
bun scripts/test.ts <test-file>     # targeted tests
bun run test                        # full suite, one worker per file (default)
bun run test:isolated               # full suite in ONE process: the hermeticity gate
bun e2e/onboarding.ts               # offline distribution E2E
```

### Build & install

```sh
bun run build:web
bun run build                       # installable bundle
bun run build:docs                  # static docs site (docs/dist)
bun run install:omp-web             # build, pack, install into ~/.omp-web/install/
```

## Repo layout

| Path | Ownership |
| --- | --- |
| `apps/cli/` | Installed entrypoint, update, collab CLI |
| `apps/session/` | Session daemon, dispatch, SSE delivery, callback/log mirroring |
| `apps/fleet/` | Registry, supervision, callback pair (session dial-out), browser edge, control API, stats, clone lifecycle |
| `apps/web/` | `state.ts` facade, actions in `store/`, feature logic (`chat/`, `prompt/`, `subagents/`, `fleet-ui/`, ...), `ModalHost.tsx`, presentational `components/`, optional feature entries in `features/` (see Frontend invariants) |
| `apps/design-system/` | Component showcase: Bun server + Solid transform, App drill-down nav from the render graph, stories, typed fixtures, fixture HTTP routes |
| `lib/` | Closed wire/runtime/session-files/sdk-settings/platform/testkit libraries |
| `apps/*/test/`, `lib/*/test/`, `scripts/test/`, `e2e/` | Owner-local tests and cross-app/distribution checks |
| `scripts/`, `docs/release.md` | Tooling and release contracts |

Production source is flat in cli/fleet/session; preserve the web feature hierarchy. `apps/web/components/` groups by feature, matching `store/` modules: `ui/` (domain-free primitives, no `state.ts` import), `app/` (shell widgets), `chat/{status,transcript,tools,composer,controls}`, `requests/` (agent-to-user dialogs that self-mount on store state), `sessions/`, `models/`, `settings/{integrations}`, `usage/`, `fleet/{sidebar,daemon,workspaces}`, `subagents/`, `review/`. `apps/web/tx/` (Analysis) stays a self-contained feature, wired by `features/analysis.tsx`. A component used by exactly one parent lives in that parent's folder. Logic and types stay out of `components/`.

Component names say what the user sees, one name per concept, no abbreviations; a file holding one component is named after it. Suffixes: `*Dialog` (centered `Modal`), `*Sheet` (`Modal variant="sheet"`, right side sheet), `*Lightbox` (`Modal variant="lightbox"`, full-bleed media), `*Picker` (choose one item, in a `Modal` or inline), `*Panel` (shell-less review/workspace body; its host supplies the shell), `*Tab` (hub tab body), `*Card` (transcript item), `*ToolCard` (tool call renderer), `*Row` (list row), `*Bar` (strip above the composer). `Modal` names only the `components/ui/Modal.tsx` primitive; no other component ends in `Modal`.

Overlay is the umbrella term, not a suffix: a portaled layer above the app shell whose open state lives in the store. Every overlay renders through `Modal` (blocking: `aria-modal`, focus trap, Esc, backdrop, focus restore) except non-blocking `Toasts`. Not overlays: layout drawers (the narrow-viewport sidebar slide-out and its `.sidebar-scrim`, owned by the sidebar component) and anchored popovers (`KebabMenu`, `AutocompletePopup`, owned by their trigger).

## The wire contract (OMP_PROTO 2)

Agent transport is HTTP + SSE, not WebSocket (collab-only). Browser to fleet: `GET /events` SSE down, `POST /command` up, ID-keyed commands accepted with `202`, answers via SSE `call_result`. Fleet to session: only the session-initiated callback pair (`OMP_CALLBACK_PROTO 1`, `lib/wire/callback-protocol.ts`): `POST /callback/up` NDJSON, `GET /callback/down` SSE, `POST /callback/bulk/<id>`; browser streams and commands ride it as virtual streams. A session's own `/events` and `/command` listener stays for direct clients; the fleet never uses it. `lib/wire/protocol.ts` owns frame shapes/constants. Fleet stamps session identity.

## Invariants & conventions, read before editing

### Protocol (`lib/wire/`)

- Changes are additive-only unless the version is bumped with both gates: `OMP_PROTO` (frames) is gated in `apps/fleet/edge.ts` (daemon `hello_ok`) and `apps/web/state.ts`; `OMP_CALLBACK_PROTO` (the callback pair) is gated in `lib/wire/callback-protocol.ts`, shared by `apps/fleet/daemon-transport.ts` and `apps/session/fleet-callback.ts`.
- Waived once, by user decision: roster `managed` was removed and `worktree_delete_info.owned` renamed to `linked` without a bump. Both are edge-produced and fail safe across versions (delete hidden or refused, never wrongly allowed).
- Preserve byte-bounded history, chunk accumulation, and replay/backpressure semantics. `stream_reset` ends a stream, not the daemon. Do not clip messages merely because they exceed the frame batch target.
- Command retries reuse the same ID within the dedup window. Duplicates replay answers, never re-dispatch; replay across daemon process changes must fail, never execute again.

### Server

- Daemon stdout is reserved for `OMP_SESSION|` contract lines (informational for whoever launched it; the fleet does not parse it); logs go to stderr. Spawned sessions' stdout/stderr land in `<state dir>/session-logs/<daemonId>.log`.
- Preserve `methods.ts` classification: read-only calls skip mutation broadcasts, history reloads resync before answers, prompts are readiness-gated.
- Loopback auth exemption does not extend off-loopback: binding without a token fails startup; wrong credentials return 401.
- Callback transport requires workspace/generation identity and HTTPS, except explicitly allowed loopback HTTP. Configured proxies must be http/https, never silently ignored.
- Downloads stay realpath-jailed; file listings stay inside cwd. Idle exit requires no clients (local `/events` streams or callback browser streams) or active work, tools, dialogs, or collab room.
- With a callback pair configured, a session redials with backoff and never shuts down on a dropped pair alone: it exits gracefully after `--control-grace` without a ready pair, at once on a fleet `shutdown` control, and at once on a credential rejection (401, 409 `generation_obsolete`). Pair commands share the `POST /command` dedup window.

### Fleet

- Keep static fleet loading SDK-free; exceptional SDK access uses lazy imports.
- Mint a fresh callback credential and generation per spawn/restart; revoke the previous generation first. The fleet stores only credential digests. Never expose tokens, private workspace records, enrollment digests, or secret values in roster/debug/public profiles; debug snapshots must not expose daemon endpoints.
- Sessions outlive the control plane: fleet `close()` never kills sessions or revokes enrollments; persisted enrollments re-enroll at boot so sessions redial with their original credential. Status of every non-clone entry comes from pair state. `stop`/`remove` send the `shutdown` control and revoke.
- Answers go only to the originating browser. Disconnects and origin-map caps must not discard outstanding replay protection. Reject replays when the daemon's generation or credentials change.
- Fleet/session files use exclusive lifetime locks. Session-lock exit 77 must not restart; fail waiting attaches and return the entry to asleep.
- Registry writes are atomic; project/daemon IDs are monotonic, never reused. Validate explicit resume files against the owning worktree's listing, never arbitrary paths.
- Worktree deletion requires a local linked Git worktree of the owning project and a clean tree. No force; branch deletion uses `git branch -d`, never `-D`. Transcripts survive worktree deletion.
- Clone operations go through `workspace-lifecycle.ts`, never handler self-fetches. Persist retry-sensitive state before provider steps; prove predecessor termination before replacement, never PID-only.
- Clone stop preserves checkout/logs. Deletion requires proven stop, Git guards, transcript-store verification against the volume, and read-only protection before provider/volume removal. No force bypass; transcripts are not source backup.
- Resume restores the requested durable session or fails explicitly, never silently boots fresh or substitutes upstream source. A spawned session respawns with `--resume <lastSessionFile>`; the edge records `lastSessionFile` from the `state` frame every session publishes on its control stream at each pair-up. Stored-history reads never wake compute; retention/purge is explicit, not automatic GC.
- The fleet never dials a session: every session, local or remote, connects out over the callback pair. Remote entries are never locally Git-probed. Sandboxes never mount operator agent state.
- Template substitutions require caller shell escaping. Config loading stays read-only; preserve the TTY-only first-run writer.

### Frontend (`apps/web/`)

- One `createStore` in `state.ts`; components mutate shared data only through exported actions.
- Every overlay mounts through `ModalHost.tsx`: one renderer per `ModalName` (typed `satisfies Record<ModalName, …>`) plus the self-mounting dialogs gated on their own store slot. Never mount overlays from `App.tsx` or from a trigger component; a trigger sets store state, `ModalHost` renders. `ModalHost` wraps shell-less `*Panel` bodies in their `Modal`.
- Markdown always uses `DOMPurify.sanitize(marked.parse(...))`; model HTML is untrusted.
- Mutate streaming blocks in place; replacing objects remounts Solid `<For>` and breaks scrolling/fades.
- Preserve stale-session guards and replay dedup. Session switches reject pending calls/reset IDs without clearing fleet-scoped data.
- Preserve global CSS import order and shared design tokens; theme palettes override variables only. No CSS modules; avoid inline styles.
- Optional features are declared in `features/manifest.ts` and reach the page only through `features/registry.ts` slots: modal, overlay, command, view, status bar, sidebar footer, subagent tab, transcript card. Each `features/<id>.{ts,tsx}` default-exports a `FeatureModule`; the registry loads it only through `import("./<id>")`, so a disabled feature's JS and CSS are never fetched.
- Core code never statically imports a feature entry or a module only that feature owns; type-only imports are fine. Pure shapes and factories that core reads live in `store/slices/<id>.ts`; feature actions stay in the feature's `store/` module.
- A slash command owned by a disabled feature shows a local notice and is never forwarded to the agent (`prompt/commands.ts`). Analysis routes (`omp.view`, legacy `transcripts`, `#/s/…`, `#/stored/…`) fall back to Chat when Analysis is disabled.

### Design system (`apps/design-system/`)

- Stories render the real `apps/web` components, never copies. No fleet runs behind it: control-plane fetches are answered by `fixtures/routes.ts`, daemon commands and `call()` answers by story handlers (`daemon.ts`). Stories set state only through `seed` (a top-level store patch or a function driving real exported actions); store, fake daemon, and dialog state reset per story and variant.
- `bun run design` (stories, `stories.tsx`) and `bun run demo` (App view, `demo.tsx`) are separate standalone pages from one `server.ts`; neither links to the other. The demo is the real `<App />` in Chat Mode with fixture data, and every hash belongs to the App. Holding Shift labels the component under the pointer and its ancestors, Ctrl+Shift every mounted apps/web component (`app-view.tsx`, `labels.tsx`; parents come from `inspect-runtime.ts`'s owner tree); clicking a label opens it in `inspector.tsx`, an isolated `/?embed=<storyId>` iframe. Stories live under `#/stories` (`#/stories/coverage`, `#/stories/<storyId>`); any other hash is the stories home.
- One story file per component at `stories/<feature>/<subfolder>/<Name>.tsx`, mirroring `apps/web/components/`, default-exporting `defineStory(...)` (or an array); `registry.ts` owns the contract. A component family (`ui/icons.tsx`, `ui/buttons.tsx`) is one page: `component` lists every `ComponentRef` and `section` names its nav entry.
- Components that portal a full-screen overlay (`Modal`, `ImageLightbox`) need `tabs: true` so variants never stack, and wire their dismiss prop to the stage's `render: (ctx) => … onClose={ctx.close}`, never a no-op. Re-clicking the active tab re-seeds a variant whose overlay closed through store state (`ModalHost`).
- Adding, moving, or renaming an exported component updates its story and `ComponentRef` (`file`, `export`) in the same change; `#/stories/coverage` lists components without a story.

### Tests

- Run through `scripts/test.ts` from repo root; no live model/API dependency. Do not add retries or suppress failures.
- `bun run test` (one worker per file) is the default loop; `bun run test:isolated` runs every file in ONE process and is the hermeticity gate (before release, and whenever you add or edit a file that touches globals or module mocks). Test files must stay green under both: install process globals and `mock.module` mocks from a hook and restore them in `afterAll` (each file owns exactly what it changed, and `mock.restore()` does not undo module mocks), hand back shared store state a file mutates, and prefer a query-suffixed fresh import (`./mod.ts?fresh=<tag>`) over relying on module cache state when a module under test keeps its own process-global cache.
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
- UI: `bun run dev`, verify the actual browser surface. Component changes also get their story checked in `bun run design` (refresh after source edits; restart after `server.ts` or fixture-route edits).
- CLI/distribution/bundle/first-run: `bun e2e/onboarding.ts`.
- Docs: check paths/links.
- Release: `GATE_COMMANDS` in `scripts/release.ts` is authoritative; includes types, format, web build, full tests, onboarding, followed by packed-artifact installation smoke. Preflight is advisory, not part of orchestration.
