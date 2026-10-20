# AGENTS.md

Repository guardrails. README.md is user documentation; source types define precise contracts.

## What this repo is

Bun, TypeScript ESM, Solid.js. `omp-session` runs one in-process SDK session per daemon, bound to an immutable project directory. Durable agent truth lives in session `.jsonl` logs. `omp-web` (`apps/fleet`) supervises daemons and serves the UI: bare `omp-web` runs control plane and UI on one port, `omp-web control` runs the control plane alone, and `omp-web ui` serves the UI and proxies its API to a control plane. It holds no agent state; persistence is roster metadata, private clone workspace records, and the fleet log store. The browser has one shared store and no router.

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

Open dev's printed `ui` URL, not fleet's potentially stale `dist/` UI. Dev-spawned daemons run with a 2s `--control-grace` (`DEV_SESSION_CONTROL_GRACE` in `scripts/dev.ts`; production keeps 10m), so they exit about 2s after dev stops, by any means; a dev restart within that window lets them redial the stable per-worktree fleet port. Restart them after server edits (stop them from the UI, or restart dev and wait out the grace); they are not watched. Broker management is opt-in via `bun run dev --auth-broker`; default dev and production never manage broker startup or automatically configure credentials.

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
| `apps/session/` | Session daemon, dispatch, SSE delivery, callback/log mirroring |
| `apps/fleet/` | Registry, supervision, callback pair (session dial-out), browser edge, control API, stats, clone lifecycle |
| `apps/web/` | `state.ts` facade, actions in `store/`, feature logic (`chat/`, `prompt/`, `subagents/`, `fleet-ui/`, ...), `ModalHost.tsx`, presentational `components/`, optional feature entries in `features/` (see Frontend invariants) |
| `apps/design-system/` | Component showcase: Bun server + Solid transform, App drill-down nav from the render graph, stories, typed fixtures, fixture HTTP routes |
| `lib/` | Closed wire/runtime/session-files/sdk-settings/platform/testkit libraries |
| `apps/*/test/`, `lib/*/test/`, `scripts/test/`, `e2e/` | Owner-local tests and cross-app/distribution checks |
| `scripts/`, `docs/release.md` | Tooling and release contracts |

Production source is flat in cli/fleet/session; preserve the web feature hierarchy. `apps/web/components/` groups by feature, matching `store/` modules: `ui/` (domain-free primitives, no `state.ts` import), `app/` (shell widgets), `chat/{status,transcript,tools,composer,controls}`, `requests/` (agent-to-user dialogs that self-mount on store state), `sessions/`, `models/`, `settings/{integrations}`, `usage/`, `fleet/{sidebar,daemon,workspaces}`, `subagents/`, `review/`. `apps/web/tx/` (Analysis) stays a self-contained feature, wired by `features/analysis.tsx`. A component used by exactly one parent lives in that parent's folder. Logic and types stay out of `components/`.

Component names say what the user sees, one name per concept, no abbreviations; a file holding one component is named after it. Suffixes: `*Dialog` (centered `Modal`), `*Sheet` (`Modal variant="sheet"`, right side sheet), `*Lightbox` (`Modal variant="lightbox"`, full-bleed media), `*Picker` (choose one item, in a `Modal` or inline), `*Panel` (shell-less review/workspace body; its host supplies the shell), `*Tab` (hub tab body), `*Card` (transcript item), `*ToolCard` (tool call renderer), `*Row` (list row), `*Bar` (strip attached to the composer). `Modal` names only the `components/ui/Modal.tsx` primitive; no other component ends in `Modal`.

Overlay is the umbrella term, not a suffix: a portaled layer above the app shell whose open state lives in the store. Every overlay renders through `Modal` (blocking: `aria-modal`, focus trap, Esc, backdrop, focus restore) except non-blocking `Toasts`. Not overlays: layout drawers (the narrow-viewport sidebar slide-out and its `.sidebar-scrim`, owned by the sidebar component) and anchored popovers (`KebabMenu`, `AutocompletePopup`, owned by their trigger).

## The wire contract (OMP_PROTO 4)

Agent transport is HTTP + SSE, not WebSocket (collab-only; room traffic runs on the standalone `omp-web relay`, never on a session). Browser to fleet: `GET /events` SSE down, `POST /command` up, ID-keyed commands accepted with `202`, answers via SSE `call_result`. Fleet to session: only the session-initiated callback pair (`OMP_CALLBACK_PROTO 1`, `lib/wire/callback-protocol.ts`): `POST /callback/up` NDJSON, `GET /callback/down` SSE, `POST /callback/bulk/<id>`; browser streams and commands ride it as virtual streams. A standalone session's own `/events` and `/command` listener serves direct clients; a fleet-managed session (`--fleet-stdin`) binds no listener and the fleet never uses one. `lib/wire/protocol.ts` owns frame shapes/constants. Fleet stamps session identity.

## Invariants & conventions, read before editing

### Protocol (`lib/wire/`)

- Changes are additive-only unless the version is bumped with both gates: `OMP_PROTO` (frames) is gated in `apps/fleet/edge.ts` (daemon `hello_ok`) and `apps/web/state.ts`; `OMP_CALLBACK_PROTO` (the callback pair) is gated in `lib/wire/callback-protocol.ts`, shared by `apps/fleet/daemon-transport.ts` and `apps/session/fleet-callback.ts`.
- Preserve byte-bounded history, chunk accumulation, and replay/backpressure semantics. `stream_reset` ends a stream, not the daemon. Do not clip messages merely because they exceed the frame batch target.
- `message_update` on the session wire is a delta keyed by content block (`WireAssistantMessageEvent`), never the cumulative message. The full message goes out on `message_end`; a late joiner is primed with the in-progress message (`streamingPrimeFrames`). `toWireEvent` in `apps/session/sse-delivery.ts` is the only SDK-to-wire slimming point. Collab peer frames (`collab-host.ts`) keep the SDK shape because the SDK guest reads the full `message`.
- Command retries reuse the same ID within the dedup window. Duplicates replay answers, never re-dispatch; replay across daemon process changes must fail, never execute again.

### Server

- Daemon stdout is reserved for `OMP_SESSION|` contract lines (informational for whoever launched it; the fleet does not parse it); logs go to stderr. Spawned sessions' stdout/stderr land in `<state dir>/session-logs/<daemonId>.log`, rotated to `.log.1` above 1 MiB (see `apps/fleet/session-log.ts`); provider-managed clones write combined output to `<clone state dir>/daemon.log` under the same cap.
- Preserve `methods.ts` classification: read-only calls skip mutation broadcasts, history reloads resync before answers, prompts are readiness-gated.
- Loopback auth exemption does not extend off-loopback: binding without a token fails startup; wrong credentials return 401.
- Callback transport requires workspace/generation identity and HTTPS, except explicitly allowed loopback HTTP. Configured proxies must be http/https, never silently ignored.
- Downloads stay realpath-jailed; file listings stay inside cwd. Idle exit requires no clients (local `/events` streams or callback browser streams) or active work, tools, dialogs, or collab room.
- With a callback pair configured, a session redials with backoff and never shuts down on a dropped pair alone: it exits gracefully after `--control-grace` without a ready pair, at once on a fleet `shutdown` control, and at once on a credential rejection (401, 409 `generation_obsolete`). Pair commands share the `POST /command` dedup window.

### Fleet

- Keep static fleet loading SDK-free; exceptional SDK access uses lazy imports.
- Mint a fresh callback credential and generation per spawn/restart; revoke the previous generation first. The fleet stores only credential digests. Never expose tokens, private workspace records, enrollment digests, or secret values in roster/debug/public profiles; debug snapshots must not expose daemon endpoints.
- Sessions outlive the control plane: fleet `close()` never kills sessions or revokes enrollments; persisted enrollments re-enroll at boot so sessions redial with their original credential. Status of every non-clone entry comes from pair state, except boot reconciliation marks a local spawned session asleep immediately when its live file lock or recorded pid proves it dead. Live or unknown enrolled sessions remain reconnecting with redial grace. A ready session that loses its pair shows reconnecting only once `PAIR_LOSS_GRACE_MS` (registry.ts) passes without a re-pair, so a brief drop never flips the roster. `stop`/`remove` send the `shutdown` control and revoke. There is no operator-enrolled remote session: off-host compute is a provider-run clone.
- Answers go only to the originating browser. Disconnects and origin-map caps must not discard outstanding replay protection. Reject replays when the daemon's generation or credentials change.
- Fleet/session files use exclusive lifetime locks. Session-lock exit 77 and resume-failed exit 78 must not restart; fail waiting attaches and return the entry to asleep with the child's last log line as its reason.
- Registry writes are atomic; project/daemon IDs are monotonic, never reused. Validate explicit resume files against the owning worktree's listing, never arbitrary paths.
- Worktree deletion requires a local linked Git worktree of the owning project and a clean tree. No force; branch deletion uses `git branch -d`, never `-D`. Transcripts survive worktree deletion.
- Registered projects own their rows: the git-state sync registers every linked worktree of a project as an asleep row and marks a project `missing` when its main checkout is gone; it never auto-removes a project or its main-checkout row. Git probes use `--no-optional-locks` and a per-probe timeout; probes of one row never overlap, a sync pass never overlaps the next, and a pass probes at most `SYNC_PROBE_CONCURRENCY` rows at once. Removing a project stops and drops its rows (transcripts kept, disk untouched); clones block it. Branch deletion names the branch and runs only while it is still checked out there and is not the default/base or main-checkout branch.
- Clone operations go through `workspace-lifecycle.ts`, never handler self-fetches. Persist retry-sensitive state before provider steps; prove predecessor termination before replacement, never PID-only.
- Clone stop preserves checkout/logs. Deletion requires proven stop, Git guards, transcript-store verification against the volume, and read-only protection before provider/volume removal. No force bypass; transcripts are not source backup.
- A desired-running clone whose runtime the provider proves dead after its pair came up restarts in `workspace-lifecycle.ts` (new generation, revoke first, `restart-policy.ts` backoff and budget shared with `supervisor.ts`, `failed` with a reason when spent); a brief pair drop with a live runtime and an explicit stop never restart.
- Resume restores the requested durable session or fails explicitly, never silently boots fresh or substitutes upstream source. A spawned session respawns with `--resume <lastSessionFile>`; a provider clone wake hands `OMP_SESSION_RESUME` (strict like `--resume`; `OMP_SESSION_RESUME_UNWRITTEN=1` adopts a file not known written), for volumes the fleet cannot read the in-pod `lastSessionFile`; the edge records `lastSessionFile` from the `state` frame every session publishes on its control stream at each pair-up. Stored-history reads never wake compute; retention/purge is explicit, not automatic GC.
- The fleet never dials a session: every session connects out over the callback pair. Sandboxes never mount operator agent state.
- A fleet-spawned session gets its callback pair and listener token only on stdin (`--fleet-stdin`, one JSON payload), never in argv or the environment (`/proc/<pid>/environ` and every child inherit env). Providers convert their env handoff at the last hop.
- Template substitutions require caller shell escaping. Config loading stays read-only; preserve the TTY-only first-run writer.

### Frontend (`apps/web/`)

- One `createStore` in `state.ts`; components mutate shared data only through exported actions.
- Every overlay mounts through `ModalHost.tsx`: one renderer per `ModalName` (typed `satisfies Record<ModalName, …>`) plus the self-mounting dialogs gated on their own store slot. Never mount overlays from `App.tsx` or from a trigger component; a trigger sets store state, `ModalHost` renders. `ModalHost` wraps shell-less `*Panel` bodies in their `Modal`.
- Markdown always uses `DOMPurify.sanitize(marked.parse(...))`; model HTML is untrusted.
- Mutate streaming blocks in place; replacing objects remounts Solid `<For>` and breaks scrolling/fades.
- Preserve stale-session guards and replay dedup. Session switches reject pending calls/reset IDs without clearing fleet-scoped data.
- Preserve global CSS import order and shared design tokens; theme palettes override variables only. No CSS modules; avoid inline styles.
- Optional features are declared in `features/manifest.ts` and reach the page only through `features/registry.ts` slots: modal, overlay, command, view, main header, sidebar header, subagent tab, transcript card. Each `features/<id>.{ts,tsx}` default-exports a `FeatureModule`; the registry loads it only through `import("./<id>")`, so a disabled feature's JS and CSS are never fetched.
- Core code never statically imports a feature entry or a module only that feature owns; type-only imports are fine. Pure shapes and factories that core reads live in `store/slices/<id>.ts`; feature actions stay in the feature's `store/` module.
- A slash command owned by a disabled feature shows a local notice and is never forwarded to the agent (`prompt/commands.ts`). Analysis routes (`omp.view`, legacy `transcripts`, `#/s/…`, `#/stored/…`) fall back to Chat when Analysis is disabled.

### Design system (`apps/design-system/`)

- Stories render the real `apps/web` components, never copies. No fleet runs behind it: control-plane fetches are answered by `fixtures/routes.ts`, daemon commands and `call()` answers by story handlers (`daemon.ts`). Stories set state only through `seed` (a top-level store patch or a function driving real exported actions); store, fake daemon, and dialog state reset per story and variant.
- `bun run design` (stories, `stories.tsx`) and `bun run demo` (App view, `demo.tsx`) are separate standalone pages from one `server.ts`; neither links to the other. The demo is the real `<App />` in Chat Mode with fixture data, and every hash belongs to the App. Component labels come from `labels.tsx` + `app-view.tsx` (ancestors from `inspect-runtime.ts`), and clicking one opens `inspector.tsx`. Stories live under `#/stories` (`#/stories/coverage`, `#/stories/<storyId>`); any other hash is the stories home.
- One story file per component at `stories/<feature>/<subfolder>/<Name>.tsx`, mirroring `apps/web/components/`, default-exporting `defineStory(...)` (or an array); `registry.ts` owns the contract. A component family (`ui/icons.tsx`, `ui/buttons.tsx`) is one page: `component` lists every `ComponentRef` and `section` names its nav entry.
- Components that portal a full-screen overlay (`Modal`, `ImageLightbox`) need `tabs: true` so variants never stack, and wire their dismiss prop to the stage's `render: (ctx) => … onClose={ctx.close}`, never a no-op. Re-clicking the active tab re-seeds a variant whose overlay closed through store state (`ModalHost`).
- Adding, moving, or renaming an exported component updates its story and `ComponentRef` (`file`, `export`) in the same change; `#/stories/coverage` lists components without a story.

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

- Code: targeted tests, then types. Library/daemon/edge changes also require the full suite.
- UI: `bun run dev`, verify the actual browser surface. Component changes also get their story checked in `bun run design` (refresh after source edits; restart after `server.ts` or fixture-route edits).
- CLI/distribution/bundle/first-run: `bun e2e/onboarding.ts`.
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
