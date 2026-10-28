# AGENTS.md

Repository guardrails. README.md is user documentation; source types define precise contracts.

## What this repo is

Bun, TypeScript ESM, Solid.js. `omp-session` runs one in-process SDK session per session process, bound to an immutable project directory. Durable agent truth lives in session `.jsonl` logs. `omp-web` (`apps/fleet`) supervises session processes and serves the UI: bare `omp-web` runs control plane and UI on one port, `omp-web control` runs the control plane alone, and `omp-web ui` serves the UI and proxies its API to a control plane. It holds no agent state; persistence is roster metadata, private clone workspace records, and the fleet log store. The browser has one shared store and no router.

## Commands

### Dev

```sh
bun install                         # also run by bun run dev
bun run dev                         # first-run setup if unconfigured, then Vite HMR + fleet
bun run format                      # oxfmt, TS/TSX only
bun run design                      # component stories (own Bun server, real apps/web components)
bun run demo                        # App demo with fixture data (own Bun server)
bun run dev:docs                    # Astro dev server for docs/
```

Open dev's printed `ui` URL, not fleet's potentially stale `dist/` UI. Dev-spawned sessions run with a 2s `--control-grace` (`DEV_SESSION_CONTROL_GRACE` in `scripts/dev.ts`; production keeps 10m), so they exit about 2s after dev stops, by any means; a dev restart within that window lets them redial the stable per-worktree fleet port. Restart them after server edits (stop them from the UI, or restart dev and wait out the grace); they are not watched. Broker management is opt-in via `bun run dev --auth-broker`; default dev and production never manage broker startup or automatically configure credentials.

### Checks

```sh
bun run check                       # types + lint + format:check + full suite
bun run check:types                 # tsgo, not tsc
bun run lint                        # library boundaries + oxlint
bun run format:check
bun scripts/test.ts <test-file>     # targeted tests
bun run test                        # full suite, one worker per file (default)
bun run test:isolated               # full suite in ONE process: the hermeticity gate (releases only)
bun e2e/onboarding.ts               # offline distribution E2E
bun run profile --help              # transport profiling harness (isolated fleet, fake model, pinned cores); output in .profile-out/
bun run profile --quick             # liveness check, then a 3 s warmup + 1 rep x 10 s per scenario (~2 min)
bun run profile --save-baseline <name>                                  # record a local baseline (gitignored .profile-out/baselines/)
bun run profile --quick --compare .profile-out/baselines/<name>.json   # deltas vs that baseline
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
| `apps/cli/` | Installed entrypoint, update, standalone collab relay (`relay.ts`) |
| `apps/session/` | Session process, dispatch, client delivery (`client-delivery.ts`), callback/log mirroring |
| `apps/fleet/` | Registry, workspace lifecycle (clone and host runtimes), callback pair (session dial-out), browser edge, control API, stats, project git sync |
| `apps/web/` | `state.ts` facade, actions in `store/`, feature logic (`chat/`, `prompt/`, `subagents/`, `fleet-ui/`, ...), `ModalHost.tsx`, presentational `components/`, optional feature entries in `features/` (see Frontend invariants) |
| `apps/design-system/` | Component showcase: Bun server + Solid transform, App drill-down nav from the render graph, stories, typed fixtures, fixture HTTP routes |
| `lib/` | Closed wire/runtime/session-files/sdk-settings/platform/testkit libraries |
| `lib/themes/` | Theme contract (`types.ts`), parse/migrate/derive/contrast (`parse.ts`, `color.ts`), generated theme CSS (`css.ts`), built-in themes as JSON (`builtin/*.json`, bundled via `builtin.ts`) and the node-only custom theme loader (`loader.ts`, reads `<config dir>/themes/`). `docs/theme-schema.json` and `docs/src/content/docs/configuration/custom-themes.md` must stay in step with the validator; `.omp/skills/theme-generator/SKILL.md` maps external palettes onto it |
| `apps/*/test/`, `lib/*/test/`, `scripts/test/`, `e2e/` | Owner-local tests and cross-app/distribution checks |
| `scripts/`, `docs/release.md` | Tooling and release contracts |
| `docs/provider-protocol.md` | The provider protocol reference: ops, envelopes, identity, capabilities, profiles, layout. Keep it current with `lib/runtime/provider-protocol.ts` in the same change |

Production source is flat in cli/fleet/session; preserve the web feature hierarchy. `apps/web/components/` groups by feature, matching `store/` modules: `ui/` (domain-free primitives, no `state.ts` import), `app/` (shell widgets), `chat/{status,transcript,tools,composer,controls}`, `requests/` (agent-to-user dialogs that self-mount on store state), `sessions/`, `models/`, `settings/{integrations}`, `usage/`, `fleet/{sidebar,session,workspaces}`, `subagents/`, `activities/` (the Activities dock panel, its sections and the composer's activity bar and popovers; its pure logic is `apps/web/activities/`), `review/`, `jobs/` (job rows, detail, widgets and type icons that the Activities panel and popovers share). `apps/web/tx/` (Analysis) stays a self-contained feature, wired by `features/analysis.tsx`. A component used by exactly one parent lives in that parent's folder. Logic and types stay out of `components/`.

Component names say what the user sees, one name per concept, no abbreviations; a file holding one component is named after it. Suffixes: `*Dialog` (centered `Modal`), `*Sheet` (`Modal variant="sheet"`, right side sheet), `*Lightbox` (`Modal variant="lightbox"`, full-bleed media), `*Picker` (choose one item, in a `Modal` or inline), `*Panel` (shell-less review/workspace body; its host supplies the shell), `*Tab` (hub tab body), `*Card` (transcript item), `*ToolCard` (tool call renderer), `*Row` (list row), `*Bar` (strip attached to the composer). `Modal` names only the `components/ui/Modal.tsx` primitive; no other component ends in `Modal`.

Overlay is the umbrella term, not a suffix: a portaled layer above the app shell whose open state lives in the store. Every overlay renders through `Modal` (blocking: `aria-modal`, focus trap, Esc, backdrop, focus restore) except non-blocking `Toasts`. Not overlays: layout drawers (the narrow-viewport sidebar slide-out and its `.sidebar-scrim`, owned by the sidebar component; the right dock, which under 768px covers the whole viewport with a Back button but stays a `DockHost` kind, never a `Modal`) and anchored popovers (`KebabMenu`, `AutocompletePopup`, and everything on the `ui/Popover` surface: `NewWorkspacePopover` and the activity bar's popovers; owned by their trigger).

## The wire contract (OMP_PROTO 6)

Browser transport is one WebSocket per client: `GET /ws`, the browser socket (`lib/wire/browser-socket.ts` is the wire; read its header). Browser to fleet, `omp-web ui` and a standalone session's own listener all speak it. Query: `client` (page-scoped id), `after` (last `seq` received), `proto` (required, must equal `OMP_PROTO`), `token` (only where the page URL carries one). Text messages only, no per-message deflate. Server to client: `{"seq":N,"frame":F}`, `{"frame":F}`, `{"ping":ms}`, `{"ack":id}`, `{"nack":id,"status":S,"error":E}`; client to server: `{"cmd":C}`. ID-keyed commands are acked (was HTTP 202) or nacked with the status the old `POST /command` returned, and answers (`call_result`, `attach_result`) ride the same socket as frames, only to the originating client. Frames are spliced (`seqFrameMessage`), never re-stringified on a relay path. `seq` numbering and `after` resume follow the replay ring rules (`lib/wire/replay-ring.ts`, `CLIENT_RING_CAP`, `CLIENT_RING_BYTES`, `DELTA_SEQ_START`; `isRingedFrameType` is the one table of ringed frame types, shared by the session and edge rings and the client's dedup window); the web re-sends unacked commands with the same id after a reconnect inside `COMMAND_DEDUP_WINDOW_MS` (`store/transport.ts` outbox, `sendCommand`, which encodes a command once). A reconnect resumes without a re-prime: the fleet edge parks a dropped named client's session channel for `CLIENT_RECLAIM_MS` (it keeps feeding that client's ring; a 1001 close, a page unloading, closes it at once), and the web's re-attach (`attach` with `resume: true`) is answered `attach_result` with `resumed: true`, no `hello_ok`/`attached`/`history`/`state`, when the ring still covers `after` (`ReplayRing.evictedThrough`), the session pair is the one the channel was opened on, and no re-prime frame (`hello_ok`, `attached`, `history`, `available_commands`, `stream_reset`) was missed (`FleetEdge.#adoptParked`); the client then keeps its transcript, scope and readiness (`resumeAttachment`). Any other case, or an older peer, is an ordinary priming attach, and a `history` for the session on screen keeps the unchanged item prefix (`chat/history-reconcile.ts`) so cards are not remounted. A dial refusal is an upgrade followed by an immediate typed close, because a browser cannot read a non-101 status: close codes are 4000 + status (4400 protocol violation, 4401 sign-in, 4403 forbidden, 4426 proto mismatch, 4503 slow consumer); a server closes 4503 when a socket's buffered bytes pass `CLIENT_BACKPRESSURE_BYTES`, a send is dropped, or nothing drains for `CLIENT_STALL_MS`, and the client resumes with `after`. Keepalive is `CLIENT_KEEPALIVE_MS`; the client treats `CLIENT_SILENCE_DEADLINE_MS` without any message as dead and reconnects (`reconnectDelayMs`, 1-30 s jittered). Fleet to session: only the session-initiated callback pair (`OMP_CALLBACK_PROTO 2`, `lib/wire/callback-protocol.ts`): one WebSocket, `GET /callback/ws` upgrade with identity and credential in headers, one JSON envelope per text message, typed refusals as close codes 4000 + status; uploads are paced by an 8 MiB pair credit window (the fleet grants `pair_credit` as its consumer drains, a socket that ignores it is closed `invalid_request`), which is also what bounds the `omp-web ui` bridge; `POST /callback/bulk/<id>` stays HTTP. Browser sockets and commands ride the pair as virtual streams. The fleet refuses proto-1 `/callback/up` and `/callback/down` with 410 `proto_unsupported`. Collab room traffic runs on the standalone `omp-web relay` WebSocket, never on a session. A standalone session's own `GET /ws` listener serves direct clients (loopback exempt, off-loopback bearer as `token` query or `Authorization` header); a fleet-managed session (`--fleet-stdin`) binds no listener and the fleet never uses one. `lib/wire/protocol.ts` owns frame shapes/constants. Fleet stamps session identity.

## Invariants & conventions, read before editing

### Protocol (`lib/wire/`)

- Changes are additive-only unless the version is bumped with both gates: `OMP_PROTO` (frames) is gated in `apps/fleet/edge.ts` (session `hello_ok`) and `apps/web/state.ts`; `OMP_CALLBACK_PROTO` (the callback pair) is gated in `lib/wire/callback-protocol.ts`, shared by `apps/fleet/session-transport.ts` and `apps/session/fleet-callback.ts`.
- Preserve byte-bounded history, chunk accumulation, and replay/backpressure semantics. `stream_reset` ends a stream, not the session. Do not clip messages merely because they exceed the frame batch target.
- `message_update` on the session wire is a delta keyed by content block (`WireAssistantMessageEvent`), never the cumulative message. The full message goes out on `message_end`; a late joiner is primed with the in-progress message (`streamingPrimeFrames`). `toWireEvent` in `apps/session/client-delivery.ts` is the only SDK-to-wire slimming point: it also sends `tool_execution_update` as the appended output (a snapshot when the output did not grow; late joiners are primed by `streamingPrimeFrames`, and a history resync forces the next update to be a snapshot; it also carries a slimmed `live` status for eval and wait calls and the `async` job frame (`details.async`) of a backgrounded bash, eval or task call, each only when it changed, and a backgrounded call keeps sending updates after `tool_execution_end` until its job's last state), drops tool-result `message_start`/`message_end` (`tool_execution_end` carries the result), reduces `turn_end` to a bare marker, and replaces `agent_end.messages` with `lastAssistant`. Collab peer frames (`collab-host.ts`) keep the SDK shape because the SDK guest reads the full `message`.
- Command retries reuse the same ID within the dedup window. Duplicates replay answers, never re-dispatch; replay across session process changes must fail, never execute again.

### Server

- A session's stdout is reserved for `OMP_SESSION|` contract lines (informational for whoever launched it; the fleet does not parse it); logs go to stderr. Spawned sessions' stdout/stderr land in `<state dir>/session-logs/<workspaceId>.log`, rotated to `.log.1` above 1 MiB (see `apps/fleet/session-log.ts`); provider-managed clones write combined output to `<clone state dir>/session.log` under the same cap (readers fall back to `daemon.log` for clones created before the rename).
- Preserve `methods.ts` classification: read-only calls skip mutation broadcasts, history reloads resync before answers, prompts are readiness-gated.
- Loopback auth exemption does not extend off-loopback: binding without a token fails startup; wrong credentials return 401.
- Callback transport requires workspace/generation identity and HTTPS/WSS, except explicitly allowed loopback HTTP. Configured proxies must be http/https, never silently ignored; the WebSocket client ignores proxy env vars, so a proxy is always passed explicitly. A reverse proxy or ingress in front of the control plane must pass the `/callback/ws` upgrade and idle for longer than `SILENCE_DEADLINE_MS`, and one in front of the control plane or `omp-web ui` for browsers must pass the `/ws` upgrade and idle for longer than `CLIENT_SILENCE_DEADLINE_MS` (README, "Reverse proxy or ingress"); `omp-web preflight` probes the callback leg. A pair socket sender never relies on the socket to buffer or drop: it stops at the high-water mark and keeps unsent envelopes in its own bounded queues.
- Downloads stay realpath-jailed; file listings stay inside cwd. Idle exit requires no clients (local `/ws` sockets or callback browser streams) or active work, tools, dialogs, or collab room.
- With a callback pair configured, a session redials with backoff and never shuts down on a dropped pair alone: it exits gracefully after `--control-grace` without a ready pair, at once on a fleet `shutdown` control, and at once on a credential rejection (401, 409 `generation_obsolete`) or `proto_unsupported`. Pair commands share the browser socket's command dedup window (`COMMAND_DEDUP_WINDOW_MS`).
- A WebSocket upgrade is not covered by `requireCsrf` (it carries no CSRF header, and a cross-site page can open a socket with the victim's cookie). Every browser-socket listener therefore judges the handshake: the fleet runs `checkOrigin` on `/ws` whenever browser auth is on (that origin check replaces `requireCsrf` for commands), and loopback peers on the fleet, the `omp-web ui` forwarder and a standalone session face `browserRequestAllowed` (`lib/runtime/browser-guard.ts`, FEDGE-02: foreign `Host`, `Origin` or `Sec-Fetch-Site: cross-site` closes 4403). Logout and session expiry close that session's sockets 4401.

### Fleet

- Keep static fleet loading SDK-free; exceptional SDK access uses lazy imports.
- Static UI (`static-ui.ts`, shared by the combined process and `omp-web ui`): `/assets/*` is content-hashed and served `immutable`; everything else is `no-cache` with an ETag and answers `If-None-Match` with 304. `apps/web/build/precompress.ts` writes `.br`/`.gz` siblings into `dist/` at build time, `build-omp-web.ts` embeds them like any other dist file, and serving picks one by `Accept-Encoding` from the same source (disk or embedded) as the file, never compressing at request time. `http-compress.ts` gzips `application/json` answers over 1 KiB at the control plane's `Bun.serve` fetch; `omp-web ui` proxies them undecoded (`decompress: false`) and asks upstream for `identity` when the browser sent no `Accept-Encoding`.
- Mint a fresh callback credential and generation per spawn/restart; revoke the previous generation first. The fleet stores only credential digests. Never expose tokens, private workspace records, enrollment digests, or secret values in roster/debug/public profiles; debug snapshots must not expose session endpoints.
- Sessions outlive the control plane: fleet `close()` never kills sessions or revokes enrollments; persisted enrollments re-enroll at boot so sessions redial with their original credential. Status of every non-clone entry comes from pair state, except boot reconciliation marks a local spawned session asleep immediately when its live file lock or recorded pid proves it dead. Live or unknown enrolled sessions remain reconnecting with redial grace. A ready session that loses its pair shows reconnecting only once `PAIR_LOSS_GRACE_MS` (registry.ts) passes without a re-pair, so a brief drop never flips the roster. `stop`/`remove` send the `shutdown` control and revoke. There is no operator-enrolled remote session: off-host compute is a provider-run clone.
- Answers go only to the originating browser socket. Disconnects and origin-map caps must not discard outstanding replay protection. Reject replays when the session's generation or credentials change.
- Fleet/session files use exclusive lifetime locks. Session-lock exit 77 and resume-failed exit 78 must not restart; fail waiting attaches and return the entry to asleep with the child's last log line as its reason.
- Registry writes are atomic; project and workspace IDs are monotonic, never reused. Validate explicit resume files against the owning worktree's listing, never arbitrary paths.
- Worktree deletion requires a local linked Git worktree of the owning project and a clean tree. No force; branch deletion uses `git branch -d`, never `-D`. Transcripts survive worktree deletion.
- Registered projects own their rows: the git-state sync registers every linked worktree of a project as an asleep row and marks a project `missing` when its main checkout is gone; it never auto-removes a project or its main-checkout row. Git probes use `--no-optional-locks` and a per-probe timeout; probes of one row never overlap, a sync pass never overlaps the next, and a pass probes at most `SYNC_PROBE_CONCURRENCY` rows at once. Removing a project stops and drops its rows (transcripts kept, disk untouched); clones block it. Branch deletion names the branch and runs only while it is still checked out there and is not the default/base or main-checkout branch.
- Every runtime start, stop, restart and delete goes through `workspace-lifecycle.ts` over the runtime-provider contract (`runtime-provider.ts`): clones through their profile's provider (an executable for `bwrap` and `kubernetes`, the in-process `host-clone-provider.ts` for the `host` kind, which runs the session on the fleet host with no sandbox), main-checkout and worktree sessions through the in-process host provider (`host-provider.ts`: process mechanics only; the lifecycle owns generations, credentials, exit policy and restarts). Callers (edge, `operations.ts`, `session-waker.ts`, server routes, eviction) hold a `LifecycleApi` and call the kind-agnostic verbs `start(workspaceId, { resume? })`, `stop(workspaceId)` and `delete(workspaceId)`; the lifecycle dispatches on the workspace kind, so no call site branches on clone vs host to pick a verb (a call-site kind branch is only for genuinely different data or guards: session listings from the store vs the worktree, the worktree delete guards around `delete`, the waker's wait policy). `project-sync.ts` only observes git state and registers rows; it never runs sessions. Clone operations go through `workspace-lifecycle.ts`, never handler self-fetches. Persist retry-sensitive state before provider steps; prove predecessor termination before replacement, never PID-only.
- Clone stop preserves checkout/logs. Deletion requires proven stop, Git guards, transcript-store verification against the volume, and read-only protection before provider/volume removal. No force bypass; transcripts are not source backup.
- One crash policy for every runtime, in `workspace-lifecycle.ts` (`#restartOrGiveUp` over a per-runtime `RestartBudget`, `restart-policy.ts`; never a second implementation per kind): a host child that exits unexpectedly, or a clone whose runtime the provider proves dead after its pair came up, revokes the dead generation first, backs off 1s-30s jittered, restarts with a fresh credential and generation + 1, and past the cap between pair-ups (refilled by a pair that holds) shows status `error` + `lifecycleStage` `failed` with the reason (any provider-reported `detail` included). Exit 77/78 (a host child's or a provider-reported `exitCode`), a brief pair drop with a live runtime, and an explicit stop never restart. An explicit start gives a fresh cap.
- Resume restores the requested durable session or fails explicitly, never silently boots fresh or substitutes upstream source. A spawned session respawns with `--resume <lastSessionFile>`; a provider clone wake hands `OMP_SESSION_RESUME` (strict like `--resume`; `OMP_SESSION_RESUME_UNWRITTEN=1` adopts a file not known written), for volumes the fleet cannot read the in-pod `lastSessionFile`; the edge records `lastSessionFile` from the `state` frame every session publishes on its control stream at each pair-up. Stored-history reads never wake compute; retention/purge is explicit, not automatic GC.
- The fleet never dials a session: every session connects out over the callback pair. Sandboxes never mount operator agent state; a `host` clone is not a sandbox and runs as the fleet user, so its profile is an explicit operator choice, never a default.
- A fleet-spawned session gets its callback pair and listener token only on stdin (`--fleet-stdin`, one JSON payload), never in argv or the environment (`/proc/<pid>/environ` and every child inherit env). Providers convert their env handoff at the last hop.
- Template substitutions require caller shell escaping. Config loading stays read-only; preserve the TTY-only first-run writer.

### Frontend (`apps/web/`)

- One `createStore` in `state.ts`; components mutate shared data only through exported actions.
- Every overlay mounts through `ModalHost.tsx`: one renderer per `ModalName` (typed `satisfies Record<ModalName, …>`) plus the self-mounting dialogs gated on their own store slot. Never mount overlays from `App.tsx` or from a trigger component; a trigger sets store state, `ModalHost` renders. `ModalHost` wraps shell-less `*Panel` bodies in their `Modal`. Dialogs and sheets in that table are `lazyComponent` (`components/ui/lazy.ts`) imports, so their code stays out of the entry chunk; every layer sits in an `ErrorBoundary` that toasts and closes the modal when its chunk fails. A dialog that must paint without a round trip (the sign-in dialog) stays a static import.
- Markdown always uses `DOMPurify.sanitize(marked.parse(...))`; model HTML is untrusted.
- Mutate streaming blocks in place; replacing objects remounts Solid `<For>` and breaks scrolling/fades.
- `state.subagents` is a `ReactiveMap` (`subagents/reactive-map.ts`) written in place by the frame reducers (`applySubagentProgress`/`applySubagentLifecycle`); never replace or copy it per frame. Read the subagent forest only through `subagentForest`/`subagentTree`/`subagentById`/`fanoutTotals` (`store/subagents.ts`): one shared build per change, unchanged nodes keep their object, so never rebuild or re-derive it per consumer. Subagent transcripts are kept only while a pane shows them (`holdSubagentTranscript`) plus a few closed ones, and are dropped on a session switch.
- Preserve stale-session guards and replay dedup. Session switches reject pending calls/reset IDs without clearing fleet-scoped data. Commands go out only through `sendCommand` (`store/transport.ts`): the outbox keeps a command until it is acked and re-sends it with its original id after a reconnect, never with a new one.
- Preserve global CSS import order and shared design tokens. Themes are data, not CSS: the root carries `data-theme-variant="<id>/<scheme>"` and `data-scheme="dark|light"`, the palette comes from the generated stylesheet (`lib/themes/css.ts`, one `[data-theme-variant]` block per variant), and light-only CSS keys on `[data-scheme="light"]`, never on a theme id. `tokens.css` keeps only the hand-maintained Catppuccin first-visit fallback. No CSS modules; avoid inline styles.
- Motion timing comes only from `styles/tokens.css`: `--dur-fast`/`--dur-base` for opacity and color, `--dur-move-fast`/`--dur-move-base` for transform and size (instant under reduced motion), loop tokens for infinite animations, `--ease-out` for one-shot motion. `bun run lint` fails on a literal duration in any other web stylesheet, and on an `infinite` animation outside `@media (prefers-reduced-motion: no-preference)` (loops hold still under reduced motion). A loop animates `transform` or `opacity` only (compositor, no main-thread frame): the shimmer label slides a clipped highlight copy (`ShimmerText`), never `background-position`; a loop never runs on an empty label. Code that waits for an exit uses `afterMotion`/`createPresence` (`motion/presence.ts`), never a TS copy of a duration.
- Background work that only matters to a viewer (clocks, polls, auto-refresh) stops while the tab is hidden: use `createVisibleInterval`/`createNow` (`page-visibility.ts`, `activities/clock.ts`) or `isPageVisible()`, never a bare `setInterval`. A popover tracks its anchor with `trackAnchor` (observers and events), never a per-frame loop; a drag writes the moving element's own style once per frame and commits to the store and storage when it ends.
- `transcriptPhase` (`idle`, `waking`, `attaching`, `loaded`, `failed`) drives the transcript skeleton, empty state, failed panel and composer lock. `waking`/`attaching`/`failed` are written only by the switch path in `store/roster.ts` (`switchToSession`, `wakeAndAttach`) under the latest attach intent; `loaded` comes from `loadHistory`, or from dismissing a failed switch back to the still-attached session.
- Optional features are declared in `features/manifest.ts` and reach the page only through `features/registry.ts` slots: modal, overlay, dock panel (`docks`, read by `DockHost` through `featureDock`), command, view, settings action, subagent tab, Plugins tab (`pluginsTab`, read by the Extensions dialog). Each `features/<id>.{ts,tsx}` default-exports a `FeatureModule`; the registry loads it only through `import("./<id>")`, so a disabled feature's JS and CSS are never fetched. Activation never gates the first render: `index.tsx` starts `activateFeatures` and `render` together, and every slot accessor is reactive on the active set, so a core component never reads a slot as settled at mount. `apps/web/build/feature-preload.ts` hints the entry modules of default-on features to the browser, skipping those a stored choice turned off.
- Core code never statically imports a feature entry or a module only that feature owns; type-only imports are fine. Pure shapes and factories that core reads live in `store/slices/<id>.ts`; feature actions stay in the feature's `store/` module (core reads Git Review only through `store/git-capability.ts` and `state.review.queuedAnnotationIds`; `store/review.ts` loads with the review features or on the first queued annotation send).
- Boot order (`index.tsx`): `initTheme`, then `startBoot()` (dial `/ws`, auth probe, themes: none needs a component), `activateFeatures` in the background, clear `#root` (the static boot shell in `index.html` stands in until then) and `render(<App booted />)`. Hosts that mount `<App />` alone (the design system) get `startBoot` from App's `onMount`.
- A slash command owned by a disabled feature shows a local notice and is never forwarded to the agent (`prompt/commands.ts`). Analysis routes (`omp.view`, legacy `transcripts`, `#/s/…`, `#/stored/…`) fall back to Chat when Analysis is disabled.

### Design system (`apps/design-system/`)

- Stories render the real `apps/web` components, never copies. No fleet runs behind it: control-plane fetches are answered by `fixtures/routes.ts`, session commands and `call()` answers by story handlers (`session.ts`). Stories set state only through `seed` (a top-level store patch or a function driving real exported actions); store, fake session, and dialog state reset per story and variant.
- `bun run design` (stories, `stories.tsx`) and `bun run demo` (App view, `demo.tsx`) are separate standalone pages from one `server.ts`; neither links to the other. The demo is the real `<App />` in Chat Mode with fixture data, and every hash belongs to the App. Component labels come from `labels.tsx` + `app-view.tsx` (ancestors from `inspect-runtime.ts`), and clicking one opens `inspector.tsx`. Stories live under `#/stories` (`#/stories/coverage`, `#/stories/<storyId>`); any other hash is the stories home.
- One story file per component at `stories/<feature>/<subfolder>/<Name>.tsx`, mirroring `apps/web/components/`, default-exporting `defineStory(...)` (or an array); `registry.ts` owns the contract. A component family (`ui/icons.tsx`, `ui/buttons.tsx`) is one page: `component` lists every `ComponentRef` and `section` names its nav entry.
- Components that portal a full-screen overlay (`Modal`, `ImageLightbox`) need `tabs: true` so variants never stack, and wire their dismiss prop to the stage's `render: (ctx) => … onClose={ctx.close}`, never a no-op. Re-clicking the active tab re-seeds a variant whose overlay closed through store state (`ModalHost`).
- Adding, moving, or renaming an exported component updates its story and `ComponentRef` (`file`, `export`) in the same change; `#/stories/coverage` lists components without a story.
- The design system never does what the app cannot: boot and `resetStore` activate `ENABLEABLE_FEATURE_IDS` (every feature that is not in development), and `setFeaturePreference` refuses to enable an in-development feature, so stories never show UI of Analysis, Plan Mode, Git Review, or Todos being enabled (their `tx/` and `review/` stories render components directly, as previews of work in development). The todo tool card is core, not part of Todos, and keeps its story.

### Tests

- Run through `scripts/test.ts` from repo root; no live model/API dependency. Do not add retries or suppress failures.
- `bun run test` (one worker per file) is the default loop; `bun run test:isolated` runs every file in ONE process and is the hermeticity gate, run only when preparing a release, never in the everyday loop. Write test files so they would pass under both (the release run checks it): install process globals and `mock.module` mocks from a hook and restore them in `afterAll` (each file owns exactly what it changed, and `mock.restore()` does not undo module mocks), hand back shared store state a file mutates, and prefer a query-suffixed fresh import (`./mod.ts?fresh=<tag>`) over relying on module cache state when a module under test keeps its own process-global cache.
- Capture full-suite output in a log, not a truncated pipe.
- Scratch dirs use tracked `tempDir()` from `lib/testkit/temp-dir.testkit.ts`, never raw mkdtemp. Helpers use `*.testkit.ts` to avoid discovery.
- `apps/cli/test/collab-relay.test.ts` and `apps/cli/test/relay.test.ts` intentionally omit `server.stop()`: Bun hangs closing sockets with close codes.

### Style

- Tabs, `import type`, tsgo, oxlint, oxfmt. Markdown/CSS/HTML/JSON stay hand-maintained.
- Shared imports use extensionless `#lib/...`; local imports stay relative. Root package owns the mapping. Imports from `lib/` stay within `lib/`, with no cycles.
- Git identity comes only from the user's `.gitconfig`; never set/override it. Missing identity means stop and report.
- **SDK pins**: all seven `@oh-my-pi/*` packages are pinned exactly and bumped together, without dependency patches; never hand-edit `node_modules`. The `sdk-reconcile` skill owns the procedure. Fresh installs have no root `patchedDependencies` entry for `pi-agent-core`; prefixes installed by releases up to 0.2.0 retain that legacy entry until manually removed, and install and update do not remove it. Clean-prefix SDK behavior comes from the pinned upstream version.
- `apps/fleet/embedded-dist.ts` is a checked-in `{}` stub; build regenerates/restores it. Never hand-edit generated imports. Install into the pinned prefix, not a shared global SDK store.
- Preserve `finding #N` audit numbering. Keep affected docs current. Prose uses no em dashes; numeric-range en dashes are fine.

## Editing workflows

Update wire contracts, producers, consumers, dispatch classification, and behavior tests together. For bugs, reproduce before fixing and confirm afterward. Read the affected implementation rather than treating this file as a complete specification.

## Verification

- Code: targeted tests, then types. Library/session/edge changes also require the full suite.
- UI: `bun run dev`, verify the actual browser surface. Component changes also get their story checked in `bun run design` (refresh after source edits; restart after `server.ts` or fixture-route edits).
- CLI/distribution/bundle/first-run: `bun e2e/onboarding.ts`.
- Transport/wire changes (`lib/wire/`, `apps/fleet/{edge,fleet-websocket,ui-server,session-transport}.ts`, `apps/session/{client-delivery,fleet-callback,session-control}.ts`): record a baseline of `main` on your host (`--save-baseline`), then from the branch run `bun run profile --quick --compare .profile-out/baselines/<name>.json` and read the deltas; they are advisory (the command always exits 0 on compare), but a failing liveness check or a regression outside the noise band needs an explanation. Do not compare runs made with `--cpuprofile`/`--heap`, different pinning, or different hosts. Baselines stay local; record conclusions worth keeping as prose in `scripts/profile/results/`.
- Docs: check paths/links.
- Release: `GATE_COMMANDS` in `scripts/release.ts` is authoritative; includes types, format, web build, full tests, onboarding, followed by packed-artifact installation smoke. Preflight is advisory, not part of orchestration.

## Issues with screenshots

An issue whose body has a `Screenshots:` list (also meta `screenshots`, a JSON array of absolute paths) was filed from a screenshot. Before planning, `read` every listed image; it is the primary statement of the problem. If a file is missing, set `work.attention needs-human` with the missing path rather than guessing.

<!-- BEGIN KATA (managed by `kata init --with-agents`) -->
Kata is the system of record for intent.

- Never `kata delete` or `kata purge` without explicit user authorization.

~~~dot
digraph kata {
  rankdir=TB; node [shape=box];

  arrive   [shape=diamond label="Work arrives"];
  search   [label="Search first:\nkata search \"<terms>\" --agent\nReuse an open issue or create one."];
  route    [shape=diamond label="Work it, or delegate it?"];

  subgraph cluster_work {
    label="";
    claim  [label="On claim or start, mark it tracked:\nkata meta set <ref> work.attention ok"];
    branch [label="If the work happens on a dedicated branch, stamp it once:\nkata meta set <ref> work.branch <branch>\nor bind at creation:\nkata create ... --meta work.branch=<branch> --idempotency-key <key>"];
    live   [label="Keep state current:\nkata meta set <ref> work.attention stuck|needs-human|ok\nkata meta set <ref> work.attention_msg \"<why>\"\nstuck = blocked; needs-human = input/review; ok = unblocked.\nRequest attention:\nkata notify <ref> --to <actor>[/<teammate>] --message <reason>"];
    claim -> branch -> live;
  }

  subgraph cluster_delegate {
    label="";
    fanout [label="Tracked children: --parent <ref>, --meta work.branch=<branch>,\n--idempotency-key <key>, --json; capture .issue.short_id.\nSubagents: distinct KATA_TEAMMATE and\nKATA_INBOX_USER=<actor>/<teammate>; keep the actor.\nRead requests: kata inbox --for <actor>[/<teammate>].\nAfter handling: kata notify <ref> --to <actor>[/<teammate>] --clear."];
    join   [label="Join with kata wait <refs> --until attention --any\nMatches needs-human or stuck; a close also completes the wait,\nand the reported reason distinguishes which. Use --timeout so a\nwrapper can tell timeout from satisfaction."];
    coord  [label="Read delegated work.*; never write it."];
    fanout -> join -> coord;
  }

  done     [shape=diamond label="Verified complete?"];
  close    [label="kata close <ref> --done\nwith a message and evidence"];
  review   [label="kata label add <ref> needs-review\nplus a comment on what remains"];
  park     [shape=diamond label="Park it?"];
  schedule [label="kata schedule <ref> <date-or-time>\nsets scheduled_on; clear with -"];
  someday  [label="kata meta set <ref> someday true --json-value\nclear with kata meta unset <ref> someday"];

  arrive -> search -> route;
  route -> claim   [label="work it"];
  route -> fanout  [label="delegate it"];
  route -> park    [label="record only"];
  live  -> done;
  coord -> done;
  done -> close    [label="yes"];
  done -> park     [label="no"];
  park -> schedule [label="start date known"];
  park -> someday  [label="start date unknown"];
  park -> review   [label="needs review"];
}
~~~

Parent links group work; they do not gate readiness, but a parent cannot close with open children.
Use --blocks <dependent> / --blocked-by <prerequisite> only for real prerequisites; they gate kata ready.
Use --related <ref> for context only. kata wait observes state without requiring a dependency edge.

One writer per key: only write your own work.*. Ignore work.* on closed issues; never write it there.
Before stopping, close completed work or update both work.attention and work.attention_msg for the handoff.

Schedule/someday defer work; deadlines don’t. kata deadline <ref> <date-or-time> sets deadline_on without changing readiness.
Reached schedules and deadlines use notify.* for the current owner, or the author when unowned; clear with kata notify <ref> --to <recipient> --clear.
<!-- END KATA -->
