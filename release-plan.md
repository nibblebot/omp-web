# omp-web — release & onboarding plan

2026-08-17. Scope: distribution (production bundle, bun-bin symlink, `omp-web update`) and first-run onboarding (data-home config via the serve TTY offer; projects/worktrees via the UI directory picker). Provider onboarding and model roles are assumed already done via the TUI — out of scope here.

**For the executing session**: prior agent-built work for Phases 1–2 sits in `stash@{0}` (see Implementation status). Start with `git stash pop`, verify/complete the Phase-1 backend, then proceed in phase order. Sequencing constraint: everything is tested **locally** (sandboxed `HOME`/`BUN_INSTALL`, local tarball, local manifest fixture) before any GitHub release; **no npm publish until the GitHub repo exists and a GitHub release is done**.

## Locked decisions (user-directed)

1. **No bun single-executable.** Copy the `@oh-my-pi/pi-coding-agent` install mechanism: single-file JS bundle + `bin` field. **SUPERSEDED on install mechanism** (user-directed): `bun install -g` was abandoned for the flat shared-store skew (see Implementation status) — the installer (`scripts/install-omp-web.ts`) runs `bun add <tarball>` in `~/.omp-web/install/` for its own pinned `@oh-my-pi/*` node_modules, then symlinks `~/.bun/bin/omp-web` (the `bin` field still drives the symlink).
2. **One entrypoint: `omp-web`.** It dispatches everything (bare `omp-web` = fleet serve, session daemon, fleet subcommands, update). The first-run data-home confirmation lives in `serve` itself (TTY offer) — there is no separate `setup` command.
3. **Nothing under `~/.omp`.** Fleet config moves from `~/.omp/fleet/config.json` to `~/.omp-web/` (the SDK's `~/.omp/agent`, owned by the TUI-onboarded pi stack, is untouched).
4. **No "repos" dir concept.** `roots`/discovery-scanning is removed entirely; no default repos directory. Every project is added by picking a directory in a file picker.
5. **Update via release version, GitHub-first**: the release channel is GitHub Releases (tarball assets + a manifest file); `omp-web update` checks the latest release and re-installs in the pinned dir (`bun remove omp-web` + `bun add <tarball>`). Same shape as oh-my-pi's npm-mode self-update, different source of truth.
6. **No npm until GitHub is done.** Nothing is published to any npm registry until the GitHub repo is set up AND a GitHub release exists. Install/symlink/serve/spawn/update are all proven locally first (Phase 5 is the gate).

## Ground truth (verified)

Install mechanism (from this machine + `node_modules/@oh-my-pi/pi-coding-agent`):

- `~/.bun/bin/omp` is a symlink → `~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js`; that package has `"bin": {"omp": "dist/cli.js"}` and ships a ~13 MB minified bundle starting `#!/usr/bin/env bun`, built by `bun build` (not `--compile`), platform/native deps resolved from `node_modules` at runtime.
- oh-my-pi self-update (`src/cli/update-cli.ts`): version check against `https://registry.npmjs.org/` (not GitHub API — avoids unauthenticated rate limits), then `bun install -g --no-cache --registry=<pinned> <pkg>@<version>`. Registry pinned across check+install (mirror-lag failure, their #1686). Gotcha: `bun install -g` doesn't reliably refresh transitive `optionalDependencies` — pin natives leaves explicitly when applicable.

Repo facts (pre-change state):

- `package.json`: `private:true`, no `version`, no `bin`; no git remote, no tags, no CI.
- The self-contained session-daemon binary build is retired; distribution is the installable bundle (`bun run build` → `dist-bundle/cli.js` via `scripts/install-omp-web.ts`).
- Default spawn template is verbatim `omp-web session --cwd {cwd} --port 0 --token {token} --name {name} {labels} {resume}` (`fleet/config.ts:53`, `DEFAULT_LOCAL_TEMPLATE`) via `sh -c` with inherited env — no binary on PATH is assumed.
- Fleet edge serves the UI from the `EMBEDDED_DIST` fallback (`fleet/edge.ts:1924`) — embedded dist, not a compiled binary — which is what makes arbitrary-cwd serving work.
- Fleet config `~/.omp/fleet/config.json`: read-only load, **nothing writes it**, shallow-merge, unknown keys tolerated (so removing `roots` needs no migration — legacy files keep loading).
- State `~/.omp-web/fleet-state.json` + O_EXCL pidfile lock (second fleet exits 77); workspaces `~/.omp-web/workspaces` (lazy); session files lock per-file (exit 1).
- Worktree adoption machinery already exists: `listUnregisteredWorktrees` finds linked worktrees **anywhere on disk** via `git worktree list` (`fleet/worktrees.ts:291`); `POST /ctl/projects/:id/worktrees {worktreePath, start}` adopts them. Deletion is guarded to realpaths under `workspaceDir` — adopted external worktrees are evict-only (403). Dedupe is realpath-keyed → 409 at both edges; batch flows must tolerate it.
- No first-run detection anywhere; `fleetFacts.configPath === null` (`fleet/server.ts:1004`) + empty roster are observable — enough to derive first-run without a marker file.
- `validateProjectPath` (`fleet/discovery.ts:202`) does not expand `~` — a literal tilde 400s today; AddProjectModal's `"~/repos/…"` placeholder misleads.
- UI gaps: cannot start a main-checkout session on an already-registered project (`spawnDaemon` has zero callers, `src/store/projects.ts:93`); WorktreeModal add-existing is discovery-list-only; zero-project UI is one sidebar line.

## Implementation status

**Phases 1–5 are implemented, verified, and in the working tree** (stash `stash@{0}` was popped and completed; the repo is uncommitted — Phase 6 is the only remaining user action). Full gate green: 883 tests across 71 files, `check:types`, `lint` (warnings only), `format:check`, and the offline E2E (`bun scripts/test-onboard.ts` — bare `omp-web` walk, 0.1.0→0.2.0). UI verified in a browser (roster mode): first-run panel, add-project picker, G4 start-session. **Per user request:** there is no `setup` command — bare `omp-web` serves, and the first-run data-home confirmation is the serve TTY offer (Phases 3–5 text below reflects the final shape).

### Phase 1 — directory picker & roots removal — DONE

Contract (frozen):

```
GET /ctl/fs/browse?path=<abs|~|~/rel>     (edge route; path optional → os.homedir())
200 → { path, parent: string|null, dirs: [{name, path, hasGit}], truncated }   // dirs only, name-sorted, 500 cap
400 → { error }                                // missing / not-a-dir / unreadable
```

- Dot-directories skipped in listings only; explicit navigation into dot-paths works. `~` expanded server-side.
- `roots` removed from `FleetConfig`/`mergeConfig`/`defaultConfig`; root scanning deleted from `fleet/discovery.ts` (`validateProjectPath`, `resolveWorktreeOf` stay; gains `~` expansion). `GET /ctl/projects` keeps `{projects, registered}` shape; `projects` = registered projects' unregistered linked worktrees only.
- AddProjectModal: freeform path input + root-scanned picker removed → DirPicker + hasGit submit gate. WorktreeModal add-existing: keeps discovered-worktree list + "or pick a directory" DirPicker affordance.

Status:

- [x] `src/fleet-ui/dir-picker.ts` + 11 unit tests (stubbed fetch; navigation/up/error/race/truncated) — green
- [x] `src/components/roster/DirPicker.tsx` (breadcrumb, manual `~` input, git badge, select-current footer) + AddProjectModal/WorktreeModal rewiring + `dirpick-*` styles — sibling src suites green (65 tests)
- [x] `fleet/fs-browse.ts` + `/ctl/fs/browse` edge route + roots removal in `fleet/{config,discovery,server,edge,worktrees}.ts` and ~15 fleet test files — **verified** (full fleet + src suites green: 623 tests); `expandTilde` exported from `fleet/config.ts` and reused by fs-browse + `validateProjectPath`

### Phase 2 — bundle & install — DONE (in stash)

- [x] `package.json`: `"version": "0.1.0"`, `"bin": {"omp-web": "dist-bundle/cli.js"}`, `build` script (the installable bundle; `build:web` = vite-only)
- [x] `cli/omp-web.ts` dispatcher: `serve` + 13 fleet verbs → `fleet/cli.ts` main; `session` → argv-munge + dynamic import of `server/index.ts`; `--version`; usage→stderr/exit 1; nothing on stdout before delegation. 5 classification tests green
- [x] `scripts/build-omp-web.ts`: vite build → regenerate `server/embedded-dist.ts` (values anchored via `new URL(f, import.meta.url).pathname` so `Bun.file` works from any cwd) → restore stub in `finally` → `Bun.build` target=bun, minify, `@oh-my-pi/*` external, version stamped via define → `dist-bundle/cli.js` (shebang verified; `dist-bundle/` gitignored)
- [x] `fleet/edge.ts`: EMBEDDED_DIST fallback between disk-miss and placeholder (dev disk-first preserved)
- [x] Verified: `--version` → `0.1.0` from /tmp; `session --port 0` prints `OMP_SESSION|…listening`; `serve --port 0` banner exact + real index.html served from cwd=/tmp; `sessions` output byte-identical to `bun fleet/cli.ts sessions`
- [x] Pinned install + symlink verification: `bun pm pack` → `omp-web-0.1.0.tgz` (now ~193 KB — `package.json` gained a `files: ["dist-bundle/"]` field; bun pm pack otherwise ships src/tests/docs) → `scripts/install-omp-web.ts` (bun add into `~/.omp-web/install/`, bin symlink). **`bun install -g` was abandoned**: the flat global store shares `@oh-my-pi/*` with the omp CLI and keeps its version (17.3.5) instead of the tarball's pin (17.1.8) → the bundle crashes at runtime (`zodToWireSchema` missing — reproduced on the real machine). The pinned dir gives omp-web its own exact-version node_modules; the E2E poisons the store with 17.3.5 and asserts `--version` still works. Runs from an arbitrary cwd (asserted in the Phase 5 E2E).
- [x] `DEFAULT_LOCAL_TEMPLATE` is now `omp-web session --cwd {cwd} …` (`fleet/config.ts`; contract test updated) — installed-mode spawns hit the single entrypoint; dev unaffected via `OMP_FLEET_LOCAL_TEMPLATE`

### Phase 3 — `omp-web update` — DONE

Channel: **GitHub Releases** (npm deferred — Locked decision 6). Mechanism mirrors `update-cli.ts`'s npm mode with a different source of truth:

- `omp-web update [--check] [--force] [--version x.y.z]`
- **Check**: fetch the manifest asset at the stable latest-release URL `https://github.com/<owner>/<repo>/releases/latest/download/release-manifest.json` — a plain asset download, not a GitHub API call, so no unauthenticated rate limit. Manifest schema:
  ```json
  { "version": "0.2.0", "tarball": "omp-web-0.2.0.tgz", "sha256": "…" }
  ```
  `tarball` resolves against the same `…/releases/latest/download/` base. A `--version x.y.z` pin swaps the base for `…/releases/download/v<x.y.z>/` — which requires the asset naming convention `omp-web-<version>.tgz` + `release-manifest.json` on **every** release (Phase 6 enforces it in `scripts/release.ts`).
- Env override `OMP_WEB_UPDATE_URL` repoints the check at any base URL (incl. an `http://127.0.0.1:<port>/` fixture) — the local E2E uses this; tests never hit GitHub.
- Current version from `cli/version.ts` (define stamp → `../package.json` → `"dev"`); `"dev"` refuses (update applies to installs) unless `--force --version`.
- **Apply**: download tarball to temp, verify sha256 against the manifest, then `bun remove omp-web` + `bun add <verified-local-tarball>` in the PINNED install dir (derived from `import.meta.url`: `<install>/node_modules/omp-web/dist-bundle/cli.js` → `<install>`; not-an-install → error) — a same-name path-tarball install alone trips bun 1.3.14's dependency-loop check (`--force` does not bypass; verified in the E2E), so update removes first. The installed package.json version is read back and must match the manifest. Local tiny semver compare; no new deps. `--check` prints the manifest version; result lines on stdout, `omp-web:` failures on stderr.
- Post-update: probe `127.0.0.1:4722/ctl/sessions` (1s) → advisory "fleet running on old version — restart"; running daemons refresh naturally via idle-exit + respawn.
- **Later, optional**: once GitHub releases are live, an npm publish can be added; update then prefers the npm registry (`--registry` pinned across check+install, `--no-cache` — oh-my-pi #1686) with the GitHub manifest as fallback. Not part of v1.

Status: `cli/version.ts` + `cli/update.ts` (main/applyUpdate/parseManifest/resolveBase/compareVersions/sha256Of) + 21 unit tests (fixture Bun.serve; install step stubbed) — green. `OMP_WEB_UPDATE_URL` is the channel until Phase 6 (absent → exit 1 "no update channel configured").

### Phase 4 — first-run setup — DONE

- [x] Fleet config default `~/.omp/fleet/config.json` → `~/.omp-web/config.json` (`resolveConfigPath`; explicit-arg/`OMP_FLEET_CONFIG` chain unchanged; no legacy fallback — nothing shipped). Setup wizard is the only writer of the file (unknown keys tolerated = forward-compat).
- [x] No separate `setup` command (removed per user request): bare `omp-web` routes to fleet serve (`cli/omp-web.ts` injects `serve` for an empty argv), and the first-run offer lives in `serveCmd` (`fleet/cli.ts` — `shouldOfferSetup` + TTY prompt). The offer FIRST verifies the omp stack via `fleet/omp-check.ts` (lazy SDK import — the fleet stays SDK-free: `omp` binary on PATH/`~/.bun/bin`, auth-usable providers via `ModelRegistry.getApiKeyForProvider`, default-role model from `settings.modelRoles.default`) and prints the omp-standard config advice when anything is missing ("run `omp`, set up a provider + default model in /settings, or `omp login`") — then one prompt, `Data home directory [~/.omp-web]: ` (Enter = default, an alternate path with `~/` expansion overrides, `n` declines), creates the data + workspaces dirs, writes `config.json` (`workspaceDir` key only; no `roots`) via the shared `writeConfigFile`, then boots. The offer is TTY-only, so its status lines/prompts/confirmations print to stdout normally (non-interactive spawners that parse the banner never reach it); errors go to stderr. Projects and worktrees are added from the UI's directory picker afterwards.
- [x] UI first-run empty state (replaces one-line sidebar hint; keyed off `fleetConfigPath === null` + empty roster — `configPath` rides the `registered_projects` edge frame, additive) + start-session-on-registered-project action (G4: `spawnDaemon(project.path)`; the fleet stamps `projectId` on cwd-spawns via `projectIdForCwd` so the roster groups them — G5 was superseded by the Phase-1 picker in WorktreeModal).

### Phase 5 — local verification & docs — DONE

The gate: **everything works locally before anything is published anywhere.**

- [x] **Local E2E, fully offline** (`scripts/test-onboard.ts`): sandboxed `HOME` + `BUN_INSTALL`; `bun pm pack` → POISON the sandbox store with `@oh-my-pi/pi-ai@17.3.5` (the skew that broke `bun install -g`), then install the v0.1.0 tarball via `scripts/install-omp-web.ts`; assert the bin symlinks into the pinned dir, the pinned pi-ai is 17.1.8, and `--version` works despite the poisoned store; walk the CLI end-to-end: `--version` → first-run config written (the TTY offer's write, done directly — offer is TTY-gated) → **bare `omp-web`** from an arbitrary cwd (banner intact + real embedded UI, then the repo registered + worktree adopted over the loopback API — the UI picker's path) → spawn a session on the registered project (reaches ready, cwd matches, tagged with the projectId) → **update round-trip**: fixture `Bun.serve` hosting a manifest + a rebuilt v0.2.0 tarball, `OMP_WEB_UPDATE_URL` pointed at it, run `omp-web update`, assert the pinned-dir re-install + `omp-web --version` prints 0.2.0. **All assertions pass.**
- [x] Full gate: `bun run check:types` (clean), `bun run lint` (warnings only — pre-existing, don't fail), `bun run format:check` (green; the stash's unformatted files + 2 pre-existing drift files were oxfmt'd), `bun run test` (883 pass / 0 fail, 71 files).
- [x] README (install/update, bare `omp-web` = serve + first-run offer, config path, dir-picker add-repo, roadmap) + AGENTS.md (cli/ entrypoint, bundle + test-onboard scripts, config path, fs/browse + projectIdForCwd invariants, first-run UI).

### Phase 6 — GitHub release — NOT STARTED (user action; only after Phase 5 passes)

- [ ] Create the GitHub repo + push (needs the user's account/remote — none exists today).
- [ ] `scripts/release.ts`: bump version → build bundle → `bun pm pack` → sha256 → generate `release-manifest.json` → `git tag v<x.y.z>` → `gh release create` with tarball + manifest assets (naming convention from Phase 3). First release: v0.1.0.
- [ ] Live channel check: install v0.1.0 from the release tarball URL, cut v0.2.0, run `omp-web update` against the real channel.
- [ ] Only now consider npm publish (optional; see Phase 3).

## Open decisions

- **GitHub owner/repo**: user's call at Phase 6; everything before that is name-agnostic (`OMP_WEB_UPDATE_URL` + local tarballs).
- **Resolved** — the standalone session-daemon binary build was retired once the installable bundle shipped; distribution is the bundle only.
- **npm publish**: explicitly deferred until the GitHub repo + first release exist; the product may stay GitHub-tarball-only.

## Risks & constraints

- stdout contracts are load-bearing: fleet banner line 1 `fleet listening on 127.0.0.1:<port>`; session `OMP_SESSION|{...}` lines; all logs to stderr. Dispatcher/update must not pollute stdout before delegation; the first-run offer's prompts and result lines go to stderr for the same reason.
- State locks: one fleet per state file (exit 77), session files locked per-file (exit 1). Setup writes config before boot and does repo/worktree registration over loopback HTTP after boot — never writes state directly.
- The global bun store is FLAT and shared with the omp CLI: it holds one `@oh-my-pi/*` version (omp's), so `bun install -g <tarball>` yields a version-skewed bundle (reproduced: `zodToWireSchema` missing). The pinned-dir install (scripts/install-omp-web.ts) is the fix; `omp-web update` must keep using it (derives the dir from `import.meta.url`).
- Bundle asset paths must stay `import.meta.url`-anchored (cwd-independence); dev keeps disk-first serving with the stub `{}` embedded dist.
- Adopt ≠ own: worktrees adopted from outside the workspaces dir are evict-only (403 on delete) — communicated in the UI.
- Tarball installs carry no registry integrity metadata — sha256 verification against the manifest is **our** job before `bun add`; check and install must resolve against the same manifest/base URL (the oh-my-pi #1686 mirror-lag lesson applies to any future npm mode: one pinned registry across check+install, `--no-cache`).
- `releases/latest/download/<asset>` always redirects to the newest release — never attach the manifest to drafts/prereleases, or `update` will offer them.
