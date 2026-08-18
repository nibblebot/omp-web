# omp-web — release plan

2026-08-18. Scope: first GitHub push (`nibblebot/omp-web`), first version tag, the release channel decision, and the release-script machinery. All distribution/install/update machinery is already built and locally verified (offline E2E gate green); this plan is everything from "repo exists on GitHub" onward.

## Current state (verified)

- Repo has commits, **no remote, no tags**.
- `package.json`: `version: 0.1.0`, `private: true`, `bin: {omp-web: dist-bundle/cli.js}`, `files: [dist-bundle/]`.
- Build: `bun run build` → `dist-bundle/cli.js` (single-file bundle, `@oh-my-pi/*` external, version define-stamped, shebang verified).
- Install: `scripts/install-omp-web.ts` — `bun add <tarball>` into `<prefix>/install/` (default `~/.omp-web`, pinned own node_modules) + bin symlink. NOT `bun install -g` (flat shared store skews `@oh-my-pi/*` against the omp CLI — reproduced crash).
- Update: `cli/update.ts` — `omp-web update [--check] [--force] [--version x.y.z]`, manifest + sha256 + pinned-dir re-install machinery done, but the channel base is **env-only today**: `OMP_WEB_UPDATE_URL` unset → exit 1 "no update channel configured" (`cli/update.ts:307-312`; the code comment says Phase 6 replaces the env lookup with the GitHub constant). Step 2 lands that constant.

## Release channel: GitHub Releases

GitHub Releases is the distribution and update channel, period:

- `omp-web update` is built for it (manifest + tarball assets, `releases/latest/download/…`, sha256 verify, pinned-dir re-install).
- Install from GitHub needs no registry: `bun add https://github.com/nibblebot/omp-web/releases/download/v<x>/omp-web-<x>.tgz` (or the install script pointed at the tarball). `private: true` stays.

## Update-channel contract (load-bearing, already implemented)

- Manifest asset at the stable URL `https://github.com/nibblebot/omp-web/releases/latest/download/release-manifest.json`:
  ```json
  { "version": "0.2.0", "tarball": "omp-web-0.2.0.tgz", "sha256": "…" }
  ```
- `tarball` resolves against the same `…/releases/latest/download/` base; `--version x.y.z` swaps the base to `…/releases/download/v<x.y.z>/` → **every** release must attach `omp-web-<version>.tgz` + `release-manifest.json` with exactly these names.
- sha256 verification against the manifest happens before `bun add` (tarball installs carry no registry integrity metadata — it's our job).
- `releases/latest/download/<asset>` always redirects to the newest release: **never attach the manifest to drafts or prereleases**, or `update` will offer them.

## Steps

### 1. Push to GitHub — user action

- [ ] Create `github.com/nibblebot/omp-web` (private or public — the update channel works either way; release asset downloads from a **private** repo require auth, so public is the path of least resistance for `update`).
- [ ] `git remote add origin git@github.com:nibblebot/omp-web.git && git push -u origin main`.

### 2. Default the update channel to GitHub — `cli/update.ts`

Must land **before** v0.1.0: without it, first-release installs ship with no channel and can never self-update.

- [ ] Replace the env-only lookup (`cli/update.ts:307-312`) with `const base = process.env.OMP_WEB_UPDATE_URL ?? GITHUB_RELEASES_BASE`, where `GITHUB_RELEASES_BASE = "https://github.com/nibblebot/omp-web/releases/latest/download"`. Env stays as override (the local E2E + tests use it). Delete the "Phase 6 replaces…" comments and the "no update channel configured" exit.
- [ ] `cli/update.test.ts`: case asserting the GitHub base is used when the env var is unset (existing env-override cases keep passing).
- [ ] `bun scripts/test.ts cli/update.test.ts` + `bun run check:types`.

### 3. `scripts/release.ts` — build this

One command: `bun scripts/release.ts <x.y.z>` (explicit version arg; no fancy bump modes in v1). Steps, failing fast in order:

1. **Preconditions**: clean working tree; on the default branch; `gh` CLI present and authed (`gh auth status`); tag `v<x.y.z>` does not already exist (local or remote); version arg is semver and (except for the first release) greater than `package.json` version.
2. **Gate**: `bun run check:types`, `bun run format:check`, `bun run test`. (Lint is warnings-tolerant per repo convention — skip it as a gate.)
3. **Version**: write `<x.y.z>` into `package.json` (first release: already `0.1.0`, so a no-op write is fine).
4. **Build + pack**: `bun run build` → `bun pm pack` → `omp-web-<x.y.z>.tgz`; assert the tarball name matches the convention.
5. **Manifest**: sha256 the tarball, write `release-manifest.json` (schema above) next to it.
6. **Commit + tag + push**: `git commit -am "release: v<x.y.z>"` (only if package.json changed), `git tag v<x.y.z>`, `git push origin main --follow-tags`.
7. **Release**: `gh release create v<x.y.z> omp-web-<x.y.z>.tgz release-manifest.json --title "v<x.y.z>" --notes <…>` on `nibblebot/omp-web`. Notes: generated `git log <prev-tag>..HEAD --oneline` summary is fine for v1.
8. **Verify**: `curl -fsSL https://github.com/nibblebot/omp-web/releases/latest/download/release-manifest.json` returns the manifest just uploaded.

Artifacts (`omp-web-*.tgz`, `release-manifest.json`) land in a gitignored dir (e.g. `dist-release/`); the script is idempotent-safe only up to the tag step — once the tag is pushed, re-running must refuse at precondition 1.

### 4. First release: v0.1.0

- [ ] `bun scripts/release.ts 0.1.0` — tags `v0.1.0`, creates the release with both assets.
- [ ] Sanity: `curl` the manifest URL; confirm the tarball downloads.

### 5. Live channel check (the real E2E)

- [ ] Install v0.1.0 from the release tarball URL via the install script (sandboxed `HOME`/`BUN_INSTALL`, same shape as `scripts/test-onboard.ts` but against the real channel).
- [ ] `bun scripts/release.ts 0.2.0` → second release.
- [ ] `omp-web update` (no `OMP_WEB_UPDATE_URL` — exercises the step-2 GitHub default) in the sandbox → assert re-install + `omp-web --version` prints `0.2.0`. Also `omp-web update --version 0.1.0` against the pinned-tag URL path.

### 6. Deferred

- [ ] CI — none today; the release script's local gate is the quality bar for now.

## Risks & constraints (release-relevant)

- Asset naming convention is a hard contract: `--version x.y.z` constructs `omp-web-<x.y.z>.tgz` URLs blindly. The release script enforces it; manual releases must not.
- Manifest on a prerelease/draft poisons the `latest` channel for `update` — the release script must always create a full, published (non-draft, non-prerelease) release.
- sha256 is computed over the exact bytes uploaded; generate the manifest after packing, never before a rebuild.
- Private repo + `update` = asset downloads need a token; don't go private unless update gains auth. Public repo is the default assumption.
- `package.json` version is the single source of truth; `cli/version.ts` reads it (define stamp in the bundle). The release script is the only thing that bumps it.
