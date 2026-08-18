# omp-web — release & onboarding plan

2026-08-17. Scope: distribution (production bundle, bun-bin symlink, `omp-web update`) and first-run onboarding (default dirs, first repo, workspaces from existing worktrees). Provider onboarding and model roles are assumed already done via the TUI — out of scope here.

**For the executing session**: prior agent-built work for Phases 1–2 sits in `stash@{0}` (see Implementation status). Start with `git stash pop`, verify/complete the Phase-1 backend, then proceed in phase order. Sequencing constraint: everything is tested **locally** (sandboxed `HOME`/`BUN_INSTALL`, local tarball, local manifest fixture) before any GitHub release; **no npm publish until the GitHub repo exists and a GitHub release is done**.

## Locked decisions (user-directed)

1. **No bun single-executable.** Copy the `@oh-my-pi/pi-coding-agent` install mechanism: single-file JS bundle + `bin` field + `bun install -g`, which auto-creates the symlink in bun's global bin dir.
2. **One entrypoint: `omp-web`.** It dispatches everything (fleet serve, session daemon, fleet subcommands, setup, update).
3. **Nothing under `~/.omp`.** Fleet config moves from `~/.omp/fleet/config.json` to `~/.ompweb/` (the SDK's `~/.omp/agent`, owned by the TUI-onboarded pi stack, is untouched).
4. **No "repos" dir concept.** `roots`/discovery-scanning is removed entirely; no default repos directory. Every project is added by picking a directory in a file picker.
5. **Update via release version, GitHub-first**: the release channel is GitHub Releases (tarball assets + a manifest file); `omp-web update` checks the latest release and re-installs via `bun install -g <tarball>`. Same shape as oh-my-pi's npm-mode self-update, different source of truth.
6. **No npm until GitHub is done.** Nothing is published to any npm registry until the GitHub repo is set up AND a GitHub release exists. Install/symlink/setup/serve/spawn/update are all proven locally first (Phase 5 is the gate).

## Ground truth (verified)

Install mechanism (from this machine + `node_modules/@oh-my-pi/pi-coding-agent`):

- `~/.bun/bin/omp` is a symlink → `~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js`; that package has `"bin": {"omp": "dist/cli.js"}` and ships a ~13 MB minified bundle starting `#!/usr/bin/env bun`, built by `bun build` (not `--compile`), platform/native deps resolved from `node_modules` at runtime.
- oh-my-pi self-update (`src/cli/update-cli.ts`): version check against `https://registry.npmjs.org/` (not GitHub API — avoids unauthenticated rate limits), then `bun install -g --no-cache --registry=<pinned> <pkg>@<version>`. Registry pinned across check+install (mirror-lag failure, their #1686). Gotcha: `bun install -g` doesn't reliably refresh transitive `optionalDependencies` — pin natives leaves explicitly when applicable.

Repo facts (pre-change state):

- `package.json`: `private:true`, no `version`, no `bin`; no git remote, no tags, no CI.
- Only the session daemon has a binary build (`scripts/build-omp-session.ts` → `dist-bin/omp-session`, embeds `dist/` + pi-natives). The fleet runs from source only.
- Default spawn template is verbatim `omp-session --cwd {cwd} --port 0 --token {token} --name {name} {labels} {resume}` (`fleet/config.ts:54`) via `sh -c` with inherited env — assumes a binary on PATH.
- Fleet edge serves `dist/` from **process cwd** (`fleet/edge.ts:1888`) — breaks when a global entrypoint runs from an arbitrary cwd; the compiled session binary is immune (embedded dist).
- Fleet config `~/.omp/fleet/config.json`: read-only load, **nothing writes it**, shallow-merge, unknown keys tolerated (so removing `roots` needs no migration — legacy files keep loading).
- State `~/.ompweb/fleet-state.json` + O_EXCL pidfile lock (second fleet exits 77); workspaces `~/.ompweb/workspaces` (lazy); session files lock per-file (exit 1).
- Worktree adoption machinery already exists: `listUnregisteredWorktrees` finds linked worktrees **anywhere on disk** via `git worktree list` (`fleet/worktrees.ts:291`); `POST /ctl/projects/:id/worktrees {worktreePath, start}` adopts them. Deletion is guarded to realpaths under `workspaceDir` — adopted external worktrees are evict-only (403). Dedupe is realpath-keyed → 409 at both edges; batch flows must tolerate it.
- No first-run detection anywhere; `fleetFacts.configPath === null` (`fleet/server.ts:1004`) + empty roster are observable — enough to derive first-run without a marker file.
- `validateProjectPath` (`fleet/discovery.ts:202`) does not expand `~` — a literal tilde 400s today; AddProjectModal's `"~/repos/…"` placeholder misleads.
- UI gaps: cannot start a main-checkout session on an already-registered project (`spawnDaemon` has zero callers, `src/store/projects.ts:93`); WorktreeModal add-existing is discovery-list-only; zero-project UI is one sidebar line.

## Implementation status

Work below was implemented by agents, then stashed per user request: **`stash@{0}`** ("onboarding impl (dir-picker, omp-web entrypoint+bundle, fs-browse backend-unverified)"). Recover with `git stash pop` (or `git stash show -p` to inspect). Repo tree is clean; all todos open.

### Phase 1 — directory picker & roots removal

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
- [ ] `fleet/fs-browse.ts` + `/ctl/fs/browse` edge route + roots removal in `fleet/{config,discovery,server,edge,worktrees}.ts` and ~15 fleet test files — **implemented but UNVERIFIED** (agent cancelled mid-flight; draft is in the stash, tests not run)

### Phase 2 — bundle & install — DONE (in stash)

- [x] `package.json`: `"version": "0.1.0"`, `"bin": {"omp-web": "dist-bundle/cli.js"}`, `build:omp-web` script
- [x] `cli/omp-web.ts` dispatcher: `serve` + 13 fleet verbs → `fleet/cli.ts` main; `session` → argv-munge + dynamic import of `server/index.ts`; `--version`; usage→stderr/exit 1; nothing on stdout before delegation. 5 classification tests green
- [x] `scripts/build-omp-web.ts`: vite build → regenerate `server/embedded-dist.ts` (values anchored via `new URL(f, import.meta.url).pathname` so `Bun.file` works from any cwd) → restore stub in `finally` → `Bun.build` target=bun, minify, `@oh-my-pi/*` external, version stamped via define → `dist-bundle/cli.js` (shebang verified; `dist-bundle/` gitignored)
- [x] `fleet/edge.ts`: EMBEDDED_DIST fallback between disk-miss and placeholder (dev disk-first preserved)
- [x] Verified: `--version` → `0.1.0` from /tmp; `session --port 0` prints `OMP_SESSION|…listening`; `serve --port 0` banner exact + real index.html served from cwd=/tmp; `sessions` output byte-identical to `bun fleet/cli.ts sessions`
- [ ] Actual global install + symlink verification — needs **no** release channel: `bun pm pack` → `omp-web-0.1.0.tgz`, then `bun install -g /abs/omp-web-0.1.0.tgz` in a sandboxed `HOME`/`BUN_INSTALL`; assert `$BUN_INSTALL/bin/omp-web` symlinks into the global store and runs (smoke here, full walk in Phase 5)
- [ ] Change `DEFAULT_LOCAL_TEMPLATE` to `omp-web session --cwd {cwd} …` (deferred one-liner in `fleet/config.ts` — makes installed-mode spawns hit the single entrypoint; dev unaffected via `OMP_FLEET_LOCAL_TEMPLATE`)

### Phase 3 — `omp-web update` — NOT STARTED

Channel: **GitHub Releases** (npm deferred — Locked decision 6). Mechanism mirrors `update-cli.ts`'s npm mode with a different source of truth:

- `omp-web update [--check] [--force] [--version x.y.z]`
- **Check**: fetch the manifest asset at the stable latest-release URL `https://github.com/<owner>/<repo>/releases/latest/download/release-manifest.json` — a plain asset download, not a GitHub API call, so no unauthenticated rate limit. Manifest schema:
  ```json
  { "version": "0.2.0", "tarball": "omp-web-0.2.0.tgz", "sha256": "…" }
  ```
  `tarball` resolves against the same `…/releases/latest/download/` base. A `--version x.y.z` pin swaps the base for `…/releases/download/v<x.y.z>/` — which requires the asset naming convention `omp-web-<version>.tgz` + `release-manifest.json` on **every** release (Phase 6 enforces it in `scripts/release.ts`).
- Env override `OMP_WEB_UPDATE_URL` repoints the check at any base URL (incl. an `http://127.0.0.1:<port>/` fixture) — the local E2E uses this; tests never hit GitHub.
- Current version from the dispatcher's resolution (extract to `cli/version.ts`: define stamp → `../package.json` → `"dev"`); `"dev"` refuses (update applies to installs) unless `--force --version`.
- **Apply**: download tarball to temp, verify sha256 against the manifest, then `bun install -g <verified-local-tarball>` — bun swaps the `~/.bun/bin/omp-web` symlink itself (verify the re-link in E2E). Local tiny semver compare; no new deps.
- Post-update: probe `127.0.0.1:4722/ctl/sessions` (1s) → advisory "fleet running on old version — restart"; running daemons refresh naturally via idle-exit + respawn.
- **Later, optional**: once GitHub releases are live, an npm publish can be added; update then prefers the npm registry (`--registry` pinned across check+install, `--no-cache` — oh-my-pi #1686) with the GitHub manifest as fallback. Not part of v1.

### Phase 4 — first-run setup — NOT STARTED

- [ ] Move fleet config default `~/.omp/fleet/config.json` → `~/.ompweb/config.json` (`resolveConfigPath`; explicit-arg/`OMP_FLEET_CONFIG` chain unchanged). Setup wizard becomes the only writer of the file (read-modify-write; unknown keys tolerated = forward-compat).
- [ ] `omp-web setup` (auto-offered when `serve` sees no config on a TTY; explicit otherwise):
  1. **Dirs** — data home (state + workspaces, default `~/.ompweb`), workspaces dir, config path; writes `config.json` (`workspaceDir` key only; no `roots`).
  2. **First repo** — directory picked via the Phase-1 picker backend (no default repos dir; manual entry honors `~`); wizard then boots fleet in-process and `POST /ctl/projects {path, start:true}`.
  3. **Existing worktrees** — lists the project's linked worktrees (`git worktree list`, anywhere on disk), multi-select adopt → `POST …/worktrees {worktreePath, start:false}` each; 409-tolerant; one line of copy: adopted worktrees outside the workspaces dir can be spawned but never git-removed via fleet.
  4. Prints the UI URL; stays running as `serve`. Subsequent runs: plain `omp-web serve`.
- [ ] UI first-run empty state (replaces one-line sidebar hint; keyed off no-config + empty roster — expose `configPath` in an edge frame) + start-session-on-registered-project action (G4) + freeform path in WorktreeModal (G5, superseded if picker lands there in Phase 1).

### Phase 5 — local verification & docs — NOT STARTED

The gate: **everything works locally before anything is published anywhere.**

- [ ] **Local E2E, fully offline** (heavy suite or `scripts/test-onboard.ts`): sandboxed `HOME` + `BUN_INSTALL` via tempDir(); `bun pm pack` → install the v0.1.0 tarball with `bun install -g <path>`; assert `$BUN_INSTALL/bin/omp-web` symlinks into the global store; walk the CLI end-to-end: `--version` → `setup` (dirs → first repo by directory path → existing-worktree adoption) → `serve` (banner intact + real UI served from an arbitrary cwd) → spawn a session on the registered project → **update round-trip**: fixture `Bun.serve` hosting a manifest + v0.2.0 tarball, `OMP_WEB_UPDATE_URL` pointed at it, run `omp-web update`, assert the symlink target flipped and `omp-web --version` prints 0.2.0.
- [ ] Full gate: `bun run check:types`, `bun run lint`, `bun run format:check`, `bun run test`.
- [ ] README (install/update/setup) + AGENTS.md (entrypoint, bundle, config path, picker route).

### Phase 6 — GitHub release — NOT STARTED (user action; only after Phase 5 passes)

- [ ] Create the GitHub repo + push (needs the user's account/remote — none exists today).
- [ ] `scripts/release.ts`: bump version → build bundle → `bun pm pack` → sha256 → generate `release-manifest.json` → `git tag v<x.y.z>` → `gh release create` with tarball + manifest assets (naming convention from Phase 3). First release: v0.1.0.
- [ ] Live channel check: install v0.1.0 from the release tarball URL, cut v0.2.0, run `omp-web update` against the real channel.
- [ ] Only now consider npm publish (optional; see Phase 3).

## Open decisions

- **GitHub owner/repo**: user's call at Phase 6; everything before that is name-agnostic (`OMP_WEB_UPDATE_URL` + local tarballs).
- **Fate of `build:omp-session`** (compile binary): keep as a standalone artifact or retire once the bundle ships.
- **npm publish**: explicitly deferred until the GitHub repo + first release exist; the product may stay GitHub-tarball-only.

## Risks & constraints

- stdout contracts are load-bearing: fleet banner line 1 `fleet listening on 127.0.0.1:<port>`; session `OMP_SESSION|{...}` lines; all logs to stderr. Dispatcher/setup/update must not pollute stdout before delegation.
- State locks: one fleet per state file (exit 77), session files locked per-file (exit 1). Setup writes config before boot and does repo/worktree registration over loopback HTTP after boot — never writes state directly.
- `bun install -g` transitive `optionalDependencies` drift (oh-my-pi #1686): if natives ever become our direct optional deps, pin them in the update args like omp does.
- Bundle asset paths must stay `import.meta.url`-anchored (cwd-independence); dev keeps disk-first serving with the stub `{}` embedded dist.
- Adopt ≠ own: worktrees adopted from outside the workspaces dir are evict-only (403 on delete) — communicate in setup + UI.
- Tarball installs carry no registry integrity metadata — sha256 verification against the manifest is **our** job before `bun install -g`; check and install must resolve against the same manifest/base URL (the oh-my-pi #1686 mirror-lag lesson applies to any future npm mode: one pinned registry across check+install, `--no-cache`).
- `releases/latest/download/<asset>` always redirects to the newest release — never attach the manifest to drafts/prereleases, or `update` will offer them.
