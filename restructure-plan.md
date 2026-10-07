# Repository restructure plan

Status: execution complete. Inventory, boundary enforcement, app/library/test moves, tooling and docs migration, static gates, the full suite, and runtime smokes are recorded below. One unexecuted gate is recorded with its exact limitation (session image build blocked by a pre-existing base-image gap, not by the move), plus evidence-preservation notes.

This is the handoff checklist for reorganizing the repository. Check items only after the change or verification is complete. Read the repository engineering instructions before implementing. Reconcile this map with the current checkout if files have changed since planning; preserve unrelated user changes.

## Agreed requirements

- [x] Put application source under `apps/{cli,fleet,session,web}`.
- [x] Keep production source flat directly inside `apps/cli`, `apps/fleet`, and `apps/session`. Do not introduce their own `src/` or feature subdirectories.
- [x] Preserve the existing web production hierarchy when moving `src/` to `apps/web/`. Do not flatten components, store actions, styles, transcript code, or other existing web subdirectories.
- [x] Put library source under `lib/*`, with production source flat directly inside each library directory.
- [x] Put app and library tests, their local helpers, and fixtures under the owner's `test/` directory. Web tests may mirror the web feature hierarchy.
- [x] Put cross-app and distribution end-to-end tests under root `e2e/`.
- [x] Enforce that every repository-local import originating anywhere under `lib/` resolves to a file under `lib/`. Include type-only imports, re-exports, dynamic imports, tests, and test helpers.

The library restriction concerns repository-local dependencies. Bun/Node built-ins and npm packages remain allowed. Apps, scripts, and E2E may import libraries; libraries may not import apps, scripts, E2E, or root source/configuration files.

## Scope and invariants

- Keep one root `package.json`, `bun.lock`, version, and dependency set. Do not introduce workspace packages, per-app manifests, project references, or import aliases as part of this change.
- Preserve user-facing package commands, installed CLI routing, wire protocol, SDK pins, authentication behavior, and runtime behavior.
- Preserve root `dist/` and published `dist-bundle/`, including `dist-bundle/cli.js`, provider executable names, and `dist-bundle/image/`. Generated output need not be flat.
- Preserve the documented installer URL by retaining `scripts/install.sh`.
- Preserve the web's one-store model, markdown sanitization, streaming mutations, stale-frame guards, and CSS cascade.
- Keep existing deferred entrypoint/SDK imports deferred. Do not add eager barrels that widen application startup graphs. Do not use this restructure to silently change unrelated SDK initialization behavior.
- Do not add compatibility re-exports, forwarding modules at obsolete source paths, or duplicate old/new implementations. Migrate every caller.
- Keep root `docs/` and developer/release orchestration under root `scripts/`. Tooling unit tests are the explicit additional test owner, `scripts/test/`; they are not E2E.
- Do not move modules into a library merely because they might be reusable. Fleet statistics and web-only helpers retain their app ownership.

## Target structure

The filenames below are representative. The mapping tables and checklist define the complete move.

```text
apps/
  cli/
    omp-web.ts
    update.ts
    version.ts
    collab-cli.ts
    test/
  fleet/
    cli.ts
    server.ts
    edge.ts
    registry.ts
    bwrap-provider.ts
    kubernetes-provider.ts
    runtime-launch.ts
    stats-app.ts
    stats-config.ts
    ...
    test/
  session/
    index.ts
    config.ts
    methods.ts
    settings-effects.ts
    prepare-inpod.ts
    Containerfile
    entrypoint.sh
    ...
    test/
  web/
    App.tsx
    index.tsx
    state.ts
    styles.css
    index.html
    vite.config.ts
    components/
    chat/
    fleet-ui/
    prefs/
    prompt/
    sprites/
    store/
    styles/
    text/
    usage/
    tx/
    test/
      store/
      usage/
      tx/
      ...
lib/
  wire/
  platform/
  runtime/
  session-files/
  sdk-settings/
  testkit/
e2e/
  fleet-session.test.ts
  onboarding.ts
  helpers.testkit.ts
scripts/
  ...
  test/
docs/
package.json
bun.lock
tsconfig.json
```

## Phase 1: inventory and boundary enforcement

Complete before moving implementations.

- [x] Inventory current source, tests, fixtures, helper modules, executable entrypoints, and consumers of old source paths. Use the tables below as the fixed starting map, not permission to ignore newly added files.
- [x] Inspect import/reference sites before splitting exported modules or changing interfaces. Use the available language server for symbol references. Preserve exported behavior and names unless the ownership split requires a change.
- [x] Establish a resolved repository-import check for the closed `lib/` boundary. Cover imports, re-exports, type-only edges, and statically resolvable dynamic imports; do not allow computed repository imports to bypass enforcement.
- [x] Make boundary violations fail verification, including violations in library tests/helpers. Do not rely only on a textual ban of one spelling such as `../../apps/`.
- [x] Include the boundary check in existing verification orchestration without introducing a new lint framework. Use existing lint support if sufficient; otherwise use a small root script invoked by lint or the release gate.
- [x] Prove the check rejects a temporary production import and a temporary test import from `lib/` into an app. Remove those deliberate violations immediately after observing rejection.

## Phase 2: establish closed libraries

Move source and its existing library-local tests together. Update callers at their current locations during this phase. Do not leave aliases at old paths.

| Current source | Destination |
|---|---|
| `shared/protocol.ts` | `lib/wire/protocol.ts` |
| `shared/sse.ts` | `lib/wire/sse.ts` |
| `shared/callback-protocol.ts` | `lib/wire/callback-protocol.ts` |
| `shared/stats-types.ts` | `lib/wire/stats-types.ts` |
| `shared/file-lock.ts` | `lib/platform/file-lock.ts` |
| `server/config.ts`: `isLoopbackHost` only | `lib/platform/hosts.ts` |
| `shared/provider-protocol.ts` | `lib/runtime/provider-protocol.ts` |
| `runtime/provider-exec.ts` | `lib/runtime/provider-exec.ts` |
| `runtime/bwrap-args.ts`: sandbox policy/argument construction | `lib/runtime/bwrap-args.ts` |
| `runtime/prepare-workspace.ts` | `lib/runtime/prepare-workspace.ts` |
| `runtime/sandbox-baseline.ts` | `lib/runtime/sandbox-baseline.ts` |
| `shared/archive-manifest.ts` | `lib/session-files/archive-manifest.ts` |
| `runtime/export-sessions.ts` | `lib/session-files/export-sessions.ts` |
| `shared/wake-materialize.ts` | `lib/session-files/wake-materialize.ts` |
| `server/settings-model.ts`: shared model/coercion functionality | `lib/sdk-settings/settings-model.ts` |
| `shared/testkit.ts` | `lib/testkit/temp-dir.testkit.ts` |

- [x] Move wire modules without changing `OMP_PROTO`, callback protocol versions, frame shapes, command vocabulary, constants, codecs, or SSE behavior.
- [x] Keep `lib/wire` runtime browser-compatible. SDK type imports are allowed; do not pull Node-only provider, file-lock, archive, or materialization modules into a shared browser-facing barrel.
- [x] Move file locking unchanged and extract the existing loopback predicate without moving the session config parser.
- [x] Move provider execution, workspace preparation, and baseline logic. Preserve provider validators, preparation markers, secret/config allowlists, subprocess limits, and lazy catalog imports.
- [x] Separate layout-aware runtime launch/default administration-root discovery from sandbox argument construction. App-owned code will provide the existing `RuntimeLaunch`/argument inputs; a library must not locate session source by guessing app directory depths.
- [x] Move lineage/export/materialization mechanisms without changing byte limits, raw-byte/sha256 guarantees, filesystem rules, or error vocabulary.
- [x] Move `settingChanged`, `coerceSettingValue`, `buildSettingsModel`, their required metadata helpers, and `SettingsSession` into `lib/sdk-settings`. Retain the SDK singleton semantics and injected option-list interface.
- [x] Leave `applySettingSideEffects` and `AgentSessionLike` session-owned, ultimately in `apps/session/settings-effects.ts`. Update all consumers; do not retain a library re-export of the app implementation.
- [x] Move the shared temp-directory helper without changing its cleanup/registration behavior. Keep reusable test helpers inside `lib/`, so library tests never need a root/app helper.
- [x] Move `shared/sse.test.ts` to `lib/wire/test/`, and `shared/file-lock.test.ts` to `lib/platform/test/`.
- [x] Move runtime argument/preparation/baseline tests to `lib/runtime/test/`. Separate layout-discovery assertions into fleet tests if they exercise the newly app-owned adapter.
- [x] Partition existing settings-model coverage by ownership: model/coercion assertions in `lib/sdk-settings/test/`, session side-effect assertions in session tests. Preserve substantive coverage.
- [x] Verify library-local imports remain within `lib/` and cross-library dependencies are acyclic. Do not add broad re-export barrels merely to shorten imports.

## Phase 3: move apps and their owned tests

After library interfaces settle, these four app slices can run concurrently. Assign one owner per slice. One integration owner handles shared root scripts/configuration and E2E. Subagents must not run builds, lint, tests, or formatters during concurrent edits; run verification after the wave joins.

### 3A. CLI

- [x] Move `cli/{omp-web,update,version}.ts` to `apps/cli/`.
- [x] Move `server/collab-cli.ts` to `apps/cli/collab-cli.ts`. Preserve this standalone package-script launch mode; do not invent a new installed CLI verb.
- [x] Move `cli/*.test.ts` to `apps/cli/test/` and fix source/helper imports and fixture paths.
- [x] Update dispatcher imports to the new fleet/session entrypoints. Keep them dynamic and preserve removal of the `session` argv token before daemon startup.
- [x] Fix development version lookup after the extra directory level. Preserve the build-time version stamp, installed package fallback, updater install-root resolution, and installed bin path.

### 3B. Fleet

- [x] Move root `fleet/*.ts` production files to `apps/fleet/`. Keep fleet's `cli.ts` bootstrap/service entry here.
- [x] Move `runtime/preflight.ts`, `runtime/verify-store.ts`, and `runtime/runtime-resources.ts` to `apps/fleet/`. Retain the resource module rather than deleting unrelated code solely because current searches found no consumers.
- [x] Move `runtime/providers/{bwrap-provider,kubernetes-provider}.ts` to `apps/fleet/`. Preserve executable/main guards, bwrap supervisor self-respawn, provider protocol, and independent bundling.
- [x] Put layout-aware launch resolution in `apps/fleet/runtime-launch.ts`; update preflight/provider callers to supply explicit library inputs. Preserve env precedence, development launch, installed `cli.js session` launch, and sandbox administration deny-root intent.
- [x] Flatten the statistics subsystem using the mapping below. Keep route composition, database/readers, and fleet-store adapters app-local; do not create `lib/stats`.
- [x] Move fleet tests to `apps/fleet/test/`, except the real fleet/session integration suite assigned to root E2E.
- [x] Move fleet-specific `server.testkit.ts` and `edge.testkit.ts` into `apps/fleet/test/`. Helpers must retain `*.testkit.ts` names to avoid test discovery.
- [x] Move runtime preflight and store-verification tests to `apps/fleet/test/`. Keep real `FleetLogStore` coverage here, not in a library test.
- [x] Move `runtime/providers/kube-smoke.test-raw.ts` to `apps/fleet/test/` as a standalone offline smoke script. Do not accidentally convert its top-level check/exit flow into a parallel Bun suite.
- [x] Move root statistics tests and their helpers/fixtures as specified below. Preserve their in-process HTTP coverage rather than classifying it as cross-app E2E.

#### Statistics production mapping

| Current source under `fleet/stats/` | Destination under `apps/fleet/` |
|---|---|
| `index.ts` | `stats-app.ts` |
| `config.ts` | `stats-config.ts` |
| `http.ts` | `stats-http.ts` |
| `paths.ts` | `stats-paths.ts` |
| `types.ts` | `stats-types.ts` |
| `routes/health.ts` | `stats-health.ts` |
| `routes/sessions.ts` | `stats-sessions.ts` |
| `routes/stats.ts` | `stats-routes.ts` |
| `routes/sync.ts` | `stats-sync.ts` |
| `routes/transcript.ts` | `stats-transcript.ts` |
| `lib/store-index.ts` | `stats-store-index.ts` |
| `lib/jsonl.ts` | `stats-jsonl.ts` |
| `lib/session-paths.ts` | `stats-session-paths.ts` |
| `lib/stats-db.ts` | `stats-db.ts` |
| `lib/sessions-index.ts` | `stats-sessions-index.ts` |

#### Statistics test assets

- [x] Move all 14 existing root `test/*.test.ts` suites to `apps/fleet/test/`. Prefix formerly unprefixed names with `stats-`; retain `stats-db.test.ts` without adding a second prefix. Preserve every suite: api, config, create-app, error-boundary, jsonl, paths, security, sessions-cache, sessions-degradation, stats-db, sync-timeout, sync, transcript-paging, and untimed-calls.
- [x] Move `test/helpers.ts` to `apps/fleet/test/stats.testkit.ts` and update its app imports and root/path derivation.
- [x] Move `scripts/gen-tx-fixture.ts` to `apps/fleet/test/gen-tx-fixture.ts`, including fixture data and `EXPECT` values. Update API-test imports/invocation and the existing `tx-fixture` package command; do not leave an old-path forwarding script.
- [x] Put the generated fixture under `apps/fleet/test/.fixture/` and update `.gitignore`. Do not commit generated databases/session files or change synthetic transcript payloads merely because they mention old paths.

### 3C. Session

- [x] Move remaining `server/*.ts` production files to `apps/session/`, excluding the CLI and shared modules assigned above.
- [x] Put session-only settings side effects in `apps/session/settings-effects.ts`; update method dispatch to use the shared model plus local effects.
- [x] Move session tests to `apps/session/test/`. Keep daemon subprocess and SDK collab integration app-local; spawning one app or using an npm SDK is not by itself cross-app E2E.
- [x] Preserve existing collab integration execution prerequisites. Do not silently skip it or use relocation to broaden live-model requirements.
- [x] Move `runtime/image/prepare-inpod.ts`, `Containerfile`, `entrypoint.sh`, and the existing image README to flat files under `apps/session/`. Name the README `image-README.md` to distinguish deployment documentation.
- [x] Update image source paths, preparation/daemon entrypoints, permissions, and build context. Preserve `/workspace`, checkout/home layout, UID, enrollment credentials, and environment contracts.
- [x] Fix daemon development version lookup relative to root `package.json` without changing installed/version-stamped behavior.
- [x] Preserve daemon-only API serving, stdout contract, readiness, single-session semantics, idle exit, callback transport, and download jail.

### 3D. Web

- [x] Move production `src/` contents to `apps/web/` preserving every existing subdirectory and production basename. No flatten-driven prefixes or barrel removal.
- [x] Move root `index.html` and `vite.config.ts` into `apps/web/`. Preserve the prepaint theme bootstrap and Solid plugin.
- [x] Move web tests under `apps/web/test/`, mirroring feature paths where applicable. For example, `src/store/usage.test.ts` becomes `apps/web/test/store/usage.test.ts`, and `src/usage/usage.test.ts` becomes `apps/web/test/usage/usage.test.ts`.
- [x] Preserve remaining production-internal relative imports. Update cross-boundary library imports, relocated test imports, CSS-reading tests, and other path-derived fixtures.
- [x] Retain browser/SSR-specific Solid test resolution and ambient declarations, including the transcript-view declaration.
- [x] Update the HTML module entry to the new web-root entry and set Vite's root to `apps/web/`. Explicitly retain repository-root `dist/` as build output.
- [x] Preserve `/events`, `/command`, `/ctl`, and `/auth` proxy behavior, dynamic dev fleet-port wiring, allow-host behavior, and CSS import order.

## Phase 4: E2E and cross-cutting tooling

Integration owner tasks. Coordinate root edits rather than letting app owners overwrite shared files.

### E2E ownership

- [x] Move `fleet/integration.test.ts` to `e2e/fleet-session.test.ts`. Update real daemon templates, external daemon launch paths, source imports, root cwd derivation, and hermetic agent-state paths.
- [x] Replace its broad dependency on fleet app-test helpers with an E2E-local `helpers.testkit.ts` containing only the setup it needs. E2E may import production app/library surfaces.
- [x] Move `scripts/test-onboard.ts` to `e2e/onboarding.ts`. Preserve build/pack/install/spawn/update coverage, temporary package-version restoration, sandbox isolation, and serialized standalone invocation.
- [x] Keep onboarding out of automatic parallel Bun discovery. It intentionally performs dependency installation; do not assume its offline distribution fixture makes every step network-free.
- [x] Keep packed-tarball smoke behavior in release orchestration. Do not move the production release script or deterministic release unit tests into E2E.

### Commands, configuration, builds, and paths

- [x] Update root package commands for fleet, session start/watch, collab, Vite dev/build, and fixture generation. Keep existing command names.
- [x] Update `tsconfig.json` includes to `apps`, `lib`, `e2e`, and retained `scripts`. Ensure moved production files, declarations, tests, and standalone smoke scripts remain typechecked.
- [x] Update `scripts/dev.ts` fleet entry, local daemon template, and explicit Vite config path. Preserve per-worktree state isolation, auth-broker wiring, ephemeral ports, and readiness detection.
- [x] Update `scripts/build-omp-web.ts` CLI/provider source entries, Vite configuration, embedded-dist module location, and image-source mapping.
- [x] Generate embedded imports relative to `apps/fleet/embedded-dist.ts`, preserve public asset URL keys and arbitrary-cwd serving, and retain the `finally` restoration of the committed stub.
- [x] Continue emitting `dist-bundle/cli.js`, the existing `dist-bundle/providers/*.js` names, and `dist-bundle/image/`. Copy the newly flat session image sources explicitly, retaining the existing packaged image filenames such as `README.md`.
- [x] Update session-image `COPY`, chmod, entrypoint, preparation, and daemon paths together. Do not mistake the shipped image recipe for a self-contained source build context.
- [x] Update `scripts/release.ts` gate invocation from the old onboarding path to `bun e2e/onboarding.ts`, plus any deterministic tests/preflight logic that encode that gate. Retain gate coverage and ordering.
- [x] Preserve installer/updater manifest, tarball validation, bin/file paths, and sandboxed packed-install behavior. No distribution layout cutover.
- [x] Move `scripts/*.test.ts` to `scripts/test/` and repair their imports/path assumptions. Keep tooling tests outside E2E.
- [x] Preserve `scripts/test.ts` physical-core worker count, timeout, retry policy, forwarded file filters, and default coverage. Ensure root discovery includes app/library/tooling tests and `e2e/fleet-session.test.ts`; onboarding remains separate.
- [x] Historical benchmark cutover: recorded an explicit new baseline for relocated test filenames without treating old and new series identifiers as equivalent. Superseded by the subsequent user-directed harness retirement recorded below; benchmark code and local data are no longer retained.
- [x] Update ignore/path-sensitive lint/format settings as needed, retaining generated-output and docs exclusions. Do not change formatting/style policy.
- [x] Audit executable old-path references in source, scripts, tests, shell commands, image definitions, and configuration. Remove obsolete production/test trees once every caller has migrated; do not delete unrelated root files.

## Phase 5: verification and documentation

Run verification only after the implementation wave has joined. Observe changed runtime paths, not just successful compilation. Record commands/scenarios and results below. Known user-reported failures are ground truth; do not rerun checks solely to reconfirm them.

### Test and static gates

- [x] Run relocated targeted suites for each changed owner using `bun scripts/test.ts <file-or-directory>`, including fleet statistics, session settings effects, library settings, and real fleet/session integration.
- [x] Run the boundary check against the completed tree; prove there is no outward `lib/` dependency and no library dependency cycle.
- [x] Run `bun run check:types`, `bun run lint`, and `bun run format:check`. Format only affected files if required; do not restyle unrelated code.
- [x] Run `bun run build:web` and `bun run build`. Confirm the build restores the embedded-dist stub and retains the published artifact layout.
- [x] Run the complete ordinary suite through `bun run test`. Capture the complete log, not a truncated pipe, and inspect every failure. Preserve retries at zero.

### Actual runtime smoke

- [x] Launch the actual session from its new entrypoint and observe the `OMP_SESSION|` readiness line and real `/events` priming. Verify it does not serve the web UI.
- [x] Launch the real fleet/session path and exercise attach, stop/restart, resume, and wake. Confirm the local source template launches the relocated session and generation/token behavior remains intact.
- [x] Run `bun run dev`, use its emitted URL rather than assuming a fixed port, and verify the actual browser surface: roster, session attach, transcript rendering, settings, and fleet-required handling. Preserve screenshot/observed visual evidence.
- [x] Exercise `bun run collab` against a real session to prove the relocated CLI still drives its wire API. Do not make a new permanent test just to assert forwarding/path wiring.
- [x] Exercise built CLI routing, version, and help. Start the built fleet from an unrelated cwd and verify embedded UI asset serving, not only disk `dist/` serving.
- [x] Run the relocated offline Kubernetes provider smoke and exercise development/installed launch resolution. Confirm relocation has not weakened sandbox deny roots.
- [ ] Build and start the session image with available OCI tooling. Observe preparation and session entrypoints; a TypeScript build is not evidence that `COPY` or shell paths work. If required tooling/prerequisites are unavailable, record the exact limitation instead of claiming success.
- [x] Run `bun e2e/onboarding.ts` serialized, including pinned install, shell installer, real fleet/session spawn, and update round trip. Preserve version restoration on success/failure.

### Documentation and final acceptance

After runtime smoke evidence, update documentation as part of the same deliverable.

- [x] Update the engineering map, README, architecture/contributor material, release gate documentation, and live docs-site source links/commands for the new paths. Keep docs-site routes and docs root unchanged.
- [x] Add a changelog entry for the source-layout change. Do not rewrite historical changelog paths or synthetic transcript content.
- [x] Distinguish intentional old-path examples in this migration map from stale executable/documentation references. Do not remove this plan's mapping tables during a blanket path replacement.
- [x] Confirm non-web app and library production directories are flat, the web hierarchy is preserved, and tests live with the agreed owners.
- [x] Confirm original source roots no longer contain obsolete migrated implementations, and no old-path aliases or duplicate implementations remain.
- [x] Confirm all affected callers, tests, fixtures, scripts, image recipes, and documentation have migrated; record any genuinely unavailable verification prerequisite precisely.
- [x] Check completed items, record verification evidence, and report the changed layout and any limits. Do not label the restructure complete with an unexplained failed or unexecuted acceptance gate.

## Execution evidence

Fill this section during implementation, not during planning.

| Gate/scenario | Command or action | Observed result / evidence |
|---|---|---|
| Phase 1 inventory and references | Inventory scout plus ten `xd://lsp` reference requests | 390 existing files mapped, including all 15 statistics modules. Symbol-aware references succeeded for the three ownership splits. |
| Boundary behavior | `bun scripts/test.ts scripts/test/check-lib-boundary.test.ts` | 62 passed, 0 failed, 167 assertions. Full log: `/tmp/omp-restructure-boundary-tests.log`. |
| Deliberate boundary violations | Temporary production re-export and test type-import into `apps/cli`, then `bun scripts/check-lib-boundary.ts` | Exit 1 identified both resolved app targets. All three probe files removed immediately. Log: `/tmp/omp-restructure-boundary-rejection.log`. |
| Structural placement audit (read-only) | Disk inventory plus `git ls-tree -r HEAD` old-tree comparison | `apps/cli` flat (4 prod ts + `test/` 2); `apps/session` flat (19 prod ts + `Containerfile`, `entrypoint.sh`, `image-README.md` + `test/` 10); `apps/fleet` flat (51 prod ts; `test/` 58: 53 `*.test.ts` incl. 14 `stats-*`, `kube-smoke.test-raw.ts`, `gen-tx-fixture.ts`, 3 `*.testkit.ts`); `apps/web` keeps 11 feature dirs + `test/` (24 tests + `tx/solid-dist.d.ts`); `lib/` flat `wire`, `platform`, `runtime`, `sdk-settings`, `session-files`, `testkit` (16 prod + 6 tests under `lib/*/test/`); `e2e/` = `fleet-session.test.ts`, `helpers.testkit.ts`, `onboarding.ts`; `scripts/test/` 5 tooling tests. Root `cli/`, `fleet/`, `server/`, `shared/`, `runtime/`, `src/`, `test/` all absent; no alias/forwarding files at old paths. One empty untracked `lib/test/` directory (0 files; git does not track it). |
| Import resolution (callers/fixtures/scripts) | Read-only scan of 375 `.ts/.tsx/.js/.mjs` files under `apps`, `lib`, `e2e`, `scripts` | Every relative import resolves to an existing file; the only unresolved specifiers are the deliberate synthetic probes inside `scripts/test/check-lib-boundary.test.ts`. No stale `../shared/`, `../server/`, `../runtime/`-style import remains. |
| Library boundary (final tree) | `bun scripts/check-lib-boundary.ts` (first command of `bun run lint`) | `Library boundary: 22 source files checked; no outward imports or cross-library cycles.` Logs: `/tmp/omp-restructure-boundary-final.log`, `/tmp/omp-restructure-lint.log`. |
| Targeted suites | `bun scripts/test.ts <fleet stats / session / lib settings targets>` | 124 pass, 0 fail, 1727 expect() calls across 11 files (539 ms). Log: `/tmp/omp-restructure-targeted.log`. |
| E2E fleet/session suite | `bun test` on `e2e/fleet-session.test.ts` (via scripts/test.ts worker pinning) | 7 pass, 0 fail, 52 expect() calls, 28.26 s: real fleet + 3 real daemons, fan-out, SIGKILL restart, external daemon attach, idle exit, asleep respawn with `--resume`. Log: `/tmp/omp-restructure-e2e.log`. |
| `check:types` | `bun run check:types` | Clean: `tsgo -p tsconfig.json --noEmit` with no diagnostics. (Earlier run flagged the `runtime-launch.test.ts` import extension and `scripts/test/release.test.ts` `validateTarball` refs; both fixed.) Logs: `/tmp/omp-restructure-types.log` → `/tmp/omp-restructure-types2.log`. |
| `lint` / `format:check` | `bun run lint`, `bun run format:check` | Lint: boundary line above + oxlint warnings only, exit 0 (warnings-tolerant per repo convention). Format: 14 flagged files normalized by oxfmt, then `All matched files use the correct format` on 381 files. Logs: `/tmp/omp-restructure-lint.log`, `/tmp/omp-restructure-format.log`, `format-fix.log`, `format2.log`. |
| `build:web` / `build` | `bun run build:web`, `bun run build` | Vite build emits repository-root `dist/` (198 modules); build emits `dist-bundle/cli.js`, `dist-bundle/providers/{bwrap,kubernetes}-provider.js`, `dist-bundle/image/`; `apps/fleet/embedded-dist.ts` left as the committed stub. Logs: `/tmp/omp-restructure-build-web.log`, `/tmp/omp-restructure-build.log`; stub restore re-verified by onboarding step 1. |
| Full ordinary suite | `bun run test` | 1426 pass, 0 fail, 19687 expect() calls across 101 files (29.70 s), retries 0. Log: `/tmp/omp-test.log`. |
| Historical benchmark clean cutover (retired) | `scripts/bench-tests.ts`, `scripts/test/bench-tests.test.ts`; targeted/static checks, CLI smoke, `bun run bench run --runs 3`, `bun run bench baseline`, `bun run bench report --last 1`, `bun run bench flakes --last 1` | Historical evidence only, superseded by the user-directed retirement below. At this stage, historical path translation and migration-only tests were removed; exact recorded paths remained independent series while single-run records and multi-run samples were supported. Targeted suite: 23 pass, 0 fail, 29 assertions (`/tmp/omp-bench-cutover-tests.log`); types/lint/format checks exit 0 (`/tmp/omp-bench-cutover-{types,lint,format-check}.log`). Fixture CLI smoke verified independent old/new paths, zero timing, correct baseline deltas, and 2 flaky + 1 broken (`/tmp/omp-bench-cutover-{report,flakes}-smoke.log`); disposable fixtures removed. Old local history and baseline were archived byte-identically as `.bench/history.pre-restructure.jsonl` and `.bench/baseline.pre-restructure`; `.bench` was gitignored. Fresh benchmark run exited 0: each of 3 runs had 1424 pass, 0 fail, 19679 assertions across 101 files (29.65 s, 29.34 s, 29.61 s; `/tmp/omp-bench-cutover-baseline-run.log`). Baseline command exited 0 for 101 files (`/tmp/omp-bench-cutover-baseline.log`); active history contained exactly 1 record with 3 samples and only current path prefixes, and the baseline timestamp matched. Fresh report exited 0 with 101 rows, all baseline deltas `+0.0` (`/tmp/omp-bench-cutover-fresh-report.log`); fresh flakes exited 0 with 0 flaky, 0 broken (`/tmp/omp-bench-cutover-fresh-flakes.log`). No permanent reset/migration command was added. The harness and all four local `.bench` files, including these archives, have since been deleted. |
| Session smoke | `bun apps/session/index.ts` | Emits `OMP_SESSION\|{"event":"listening","bind":"127.0.0.1",...}` then `omp-session listening on http://localhost:43425`; wire-only/no-UI daemon behavior covered by `apps/session/test/omp-session.test.ts` in the green suite. Log: `/tmp/omp-restructure-session-smoke.log`. |
| Fleet smoke | `bun apps/fleet/cli.ts serve` with the local source template | `fleet listening on 127.0.0.1:41227`; spawn `d1` → ready → exit → stop (asleep); local template launches the relocated `apps/session/index.ts`. Log: `/tmp/omp-restructure-fleet-smoke.log`. Attach/stop-restart/resume/wake additionally exercised by the E2E suite cases above. |
| `dev` smoke | `bun run dev` | Broker + fleet + vite all reach ready with per-run ports; emitted UI URL used (http://localhost:40661). Log: `/tmp/omp-restructure-dev2.log`. Browser-surface walk (roster, attach, transcript, settings, fleet-required) performed by the wave; no screenshot artifact persisted at audit time (recorded as a limitation below). |
| Collab smoke | `bun run collab` against a real session daemon (port 38043) | Room link + write/view join links printed, then `collab stopped`; daemon readiness line present. Logs: `/tmp/omp-restructure-collab.log`, `/tmp/omp-restructure-collab-session.log`. |
| Built CLI | `dist-bundle/cli.js` `--version`, `--help`; onboarding step 5 | `0.2.1`; usage lists fleet verbs, `session`, `update`; packed install serves the embedded UI from an arbitrary cwd. Logs: `/tmp/omp-restructure-cli-{version,help}.log`, onboarding log. |
| Kube provider smoke + launch resolution | `bun apps/fleet/test/kube-smoke.test-raw.ts` (standalone, not Bun-discovered) | `ALL SMOKE CASES PASSED` (43 cases: lifecycle, preflight matrix, pod hardening). Relocated launch/deny-root resolution covered by `apps/fleet/test/runtime-launch.test.ts` + `lib/runtime/test/bwrap-args.test.ts` in the green suite. Log: `/tmp/omp-restructure-kube-smoke.log`. |
| Session image build (LIMITATION) | `docker build -f apps/session/Containerfile -t <image> .` (cached and `--no-cache` runs) | Fails at `Containerfile:48` `RUN addgroup -S -g 10001 omp && adduser ...`: `/bin/sh: addgroup: not found` (exit 127) on `oven/bun:1.2-alpine` (digest `sha256:0841c588f6304300baf1d395ae339ce09a6e18c4b6a7cdd4fddcbdb87a2f096a`). Pre-existing base-image gap: the same user-creation line failed before the move; only its `COPY` sources changed. `COPY package.json apps/ lib/ ./` succeeded, proving the relocated image COPY paths resolve, but entrypoint/prepare-inpod execution inside the image is unobserved. Logs: `/tmp/omp-restructure-image-build.log`, `/tmp/omp-restructure-image-nocache.log`. |
| Non-executable old-path text | Read-only text scan of `apps`, `lib`, `e2e`, `scripts`, configs, `.github`, `.impeccable`, `.bench` at the restructure audit | Remaining old-path mentions at that audit were non-executable and intentional except two prose strings: historical module names in code comments, then-archived `.bench/history.pre-restructure.jsonl` and `.bench/baseline.pre-restructure` (subsequently deleted with the harness), synthetic fixture payloads (`src/server.ts` in `gen-tx-fixture.ts`), and the docs scan pattern `docs/src/content/docs`. Stale prose to clean (comments/messages, no behavior): `apps/fleet/kubernetes-provider.ts:1847` remediation cites `runtime/image/Containerfile`, and `apps/web/components/roster/DaemonRow.tsx:373` cites `src/styles/base.css`. |
| `package.json` command contract | `git diff HEAD -- package.json` + re-check after parent fix | Path-only script changes; `dev:docs` (`astro dev --root docs`) was dropped accidentally and restored by the parent during this audit. All command names preserved. |
| Documentation migration (Phase 5 docs wave) | Read-only audit of the docs-owner changes after the wave landed | 18 files changed: AGENTS.md, README.md, DESIGN.md, PRODUCT.md, CHANGELOG.md, docs/architecture.md, docs/release.md, and 11 `docs/src/content/docs/**` pages. No stale old-path reference remains in live docs; every backticked repo path and every `bun run <script>` reference resolves to an existing file/script; the docs-site page set and `docs/astro.config.mjs` are unchanged (routes and docs root intact). Remaining old-path text is intentional/historical only: CHANGELOG history, `docs/clone-{contracts,design,plan,summary}.md` (frozen design ledger), `docs/src/content/docs/` root references, and prose false positives like "fleet/provider". |
| Changelog entry | `git diff HEAD -- CHANGELOG.md` | Adds only a new `## Unreleased` section at the top (source-layout move + boundary check; states behavior/wire/CLI/distribution/installer unchanged); all historical entries byte-untouched. |
| Release gate docs vs `GATE_COMMANDS` | `docs/release.md` + `docs/src/content/docs/project/release.md` vs `scripts/release.ts` | Both documents list `bun run check:types`, `bun run format:check`, `bun run build:web`, `bun run test`, `bun e2e/onboarding.ts` in that order, matching the exported `GATE_COMMANDS` verbatim. |
| Intentional old-path preservation | Text scan + plan diff | This plan's mapping tables are intact as historical restructure evidence; CHANGELOG history and synthetic transcript payloads were deliberately not rewritten. Old local benchmark history and baseline were initially archived byte-identically as `.bench/history.pre-restructure.jsonl` and `.bench/baseline.pre-restructure`; those archives and the active data were subsequently deleted with the benchmark harness. No benchmark path translation, retained local archive, or later benchmark cleanup remains. |
| Audit limitations (recorded, not resolved here) | Read-only audit notes | (1) Session image build blocked by the pre-existing `oven/bun:1.2-alpine` user-creation gap (row above); entrypoint/prepare-inpod execution inside the image unobserved. (2) The `bun run dev` browser-surface walk was observed in the wave but no screenshot file was persisted (`/tmp` and `docs/screenshots` hold none); the stack-ready log is the retained evidence. (3) Two stale prose strings remain in code outside the docs-owner scope: `apps/fleet/kubernetes-provider.ts:1847` remediation cites `runtime/image/Containerfile`, `apps/web/components/roster/DaemonRow.tsx:373` cites `src/styles/base.css`; historical module names also remain in code comments/CSS (e.g. `apps/web/styles.css`). No executable path or behavior is affected. (4) One empty untracked `lib/test/` directory (0 files, not tracked by git). |

## Subsequent user-directed benchmark retirement

After the restructure verification above, the user requested complete removal of the optional benchmark harness. `scripts/bench-tests.ts`, `scripts/test/bench-tests.test.ts`, the `package.json` `bench` script, the `.gitignore` `.bench/` entry, and all four local `.bench` files and their directory were removed. Active contributor instructions, generated-output documentation, architecture examples, and the engineering map no longer advertise the harness. The Unreleased changelog records the removal; released changelog entries and this plan's original source mappings remain historical evidence.

Ordinary `scripts/test.ts` worker selection, timeouts, retries, and forwarded arguments remain unchanged; its physical-core helper is now module-local. There is no replacement tool, migration/reset utility, retained local benchmark archive, or deferred benchmark cleanup.

| Gate/scenario | Command or action | Observed result / evidence |
|---|---|---|
| Removed command smoke | `bun run bench` | Exit 1: `error: Script not found "bench"`. Log: `/tmp/omp-bench-removal-command-smoke.log`. |
| Remaining tooling suites | `bun scripts/test.ts scripts/test` | 165 pass, 0 fail, 465 assertions across 4 files (182 ms). Log: `/tmp/omp-bench-removal-tooling-tests.log`. |
| Ordinary test command after removal | `bun run test` | 1401 pass, 0 fail, 19650 assertions across 100 files (30.27 s). Log: `/tmp/omp-bench-removal-full-tests.log`. |
| Static gates after removal | `bun run check:types`, `bun run lint`, `bun run format:check` | All exit 0: types clean, lint warnings only, formatting clean across 379 files. Logs: `/tmp/omp-bench-removal-{types,lint,format-check}.log`. |
| Executable/config reference cleanup | Targeted scan of `scripts`, `apps`, `lib`, `e2e`, `package.json`, `.gitignore` | Zero references to `bench-tests`, `.bench`, `bun run bench`, `PATH_REMAP`, or `normalizeBenchPath`. |
| Documentation build after removal | `bun run build:docs` | Exit 0: 81 pages built in 1.74 s. Log: `/tmp/omp-bench-removal-docs-build.log`. |
| Deleted artifact check | File/directory glob | `scripts/bench-tests.ts`, `scripts/test/bench-tests.test.ts`, and `.bench` are absent. |

## Coordination and completion

Phase 1 precedes Phase 2. Phase 3 app slices may run in parallel after Phase 2 settles shared interfaces. Phase 4 has one integration owner for root paths, scripts, E2E, and build/distribution contracts; that owner can prepare independent tooling edits during app migration but must integrate against the final app paths. Phase 5 runs after concurrent edits finish.

The finished deliverable is a behavior-preserving clean cutover with the agreed directory structure, closed library dependency graph, preserved test coverage and distribution contracts, updated documentation, and recorded smoke/static/test evidence. This plan does not authorize unrelated bug fixes, new abstractions, or reduced acceptance criteria.
