# omp-web — releases & distribution

Durable documentation for the distribution and update channel and the release orchestrator (`scripts/release.ts`), extracted from the former `release-plan.md` (removed). The release channel contract, the update-channel contract, and the release-script spec below are load-bearing: the release script and `omp-web update` implement them, and manual releases must not violate them.

## Release channel: GitHub Releases

GitHub Releases is the distribution and update channel, period:

- `omp-web update` is built for it (manifest + tarball assets, `releases/latest/download/…`, sha256 verify, pinned-dir re-install).
- Install from GitHub needs no registry: `bun add https://github.com/nibblebot/omp-web/releases/download/v<x>/omp-web-<x>.tgz` (or the install script pointed at the tarball). `private: true` stays.

## Update-channel contract (load-bearing, implemented)

- Manifest asset at the stable URL `https://github.com/nibblebot/omp-web/releases/latest/download/release-manifest.json`:
  ```json
  { "version": "0.2.0", "tarball": "omp-web-0.2.0.tgz", "sha256": "…" }
  ```
- `tarball` resolves against the same `…/releases/latest/download/` base; `--version x.y.z` swaps the base to `…/releases/download/v<x.y.z>/` → **every** release must attach `omp-web-<version>.tgz` + `release-manifest.json` with exactly these names.
- sha256 verification against the manifest happens before `bun add` (tarball installs carry no registry integrity metadata — it's our job).
- `releases/latest/download/<asset>` always redirects to the newest release: **never attach the manifest to drafts or prereleases**, or `update` will offer them.
- `cli/update.ts` defaults the channel to `GITHUB_RELEASES_BASE` (`https://github.com/nibblebot/omp-web/releases/latest/download`); `OMP_WEB_UPDATE_URL` overrides it (the local E2E and tests use the override).

## Release orchestrator — `scripts/release.ts`

One command: `bun scripts/release.ts [<x.y.z>] [--dry-run] [--yes] [--no-llm] [--notes-file <path>] [--stage | --go]`. No version arg → **compute the bump** from commit classification. `<x.y.z>` → explicit version (overrides the computed bump). `--dry-run` → run everything through the changelog step, print the plan, touch nothing. `--notes-file <path>` → use a hand-written markdown file as the GitHub release notes instead of the changelog section (the changelog is still generated, committed to `CHANGELOG.md`, and used everywhere else; the flag only replaces what `gh release create --notes-file` gets).

**Two release modes**: `--yes` (or interactive confirm) = fully automatic — generate, validate, publish in one run. `--stage` = generate + validate everything (version write, `CHANGELOG.md`, tarball, manifest, notes, packaged-release checks) and **stop before publishing**; review `CHANGELOG.md` + `dist-release/*` (edit `dist-release/notes.md` to change the GitHub notes), then `bun scripts/release.ts --go [--yes]` publishes the staged artifacts (re-validates the staged state: tree dirty with exactly `package.json` + `CHANGELOG.md`, manifest version/sha256 consistency, tarball integrity, changelog section present; refuses anything else). A re-run of `--stage` on a staged tree fails the clean-tree precondition with a `--go` hint. Steps, failing fast in order:

1. **Preconditions**: clean working tree; on the default branch (`main`); `gh` CLI present and authed; tag `v<x.y.z>` does not already exist (local or remote); version is valid semver and (except for the first release) greater than `package.json` version.
2. **Review commits since previous release** (deterministic): `git log <prev-tag>..HEAD` (no prev tag → all commits). Classify each commit: `!`/`BREAKING CHANGE:` → breaking; `feat:`/`feat(scope):` → feat; `fix:` → fix; everything else (`docs:`, `chore:`, `refactor:`, `test:`, compound `fleet+ui:`, `ui:`, untyped subjects) → other. Print the classification table.
3. **Bump**: breaking → major; any feat → minor; else patch. No version arg: apply to current `package.json` version (first release: no prev tag → keep `0.1.0`). Explicit arg wins. Show the computed target + tag.
4. **Gate**: `bun run check:types`, `bun run format:check`, `bun run build:web`, `bun run test`. (Lint is warnings-tolerant per repo convention — skip it as a gate. `build:web` runs before `test` because the daemon suite asserts static UI serving at `/`, which needs a built `dist/` — gitignored and absent on fresh worktrees.)
5. **Changelog** (LLM-assisted, deterministic structure):
   - Deterministic skeleton: group commits by class; every commit appears in exactly one group, bullet-per-commit, hash preserved — the LLM cannot move or drop commits (validation: each hash present in its group's bullets; a group failing validation falls back to raw subjects).
   - LLM prose: lazy `await import("@oh-my-pi/pi-coding-agent")` (the same lazy-import philosophy as `fleet/omp-check.ts`), default-role model from settings, temp project dir, `hasUI: false`. The summarizer prompts **one turn per bounded chunk** (≤15 commits; long structured JSON output degrades on big histories) plus one final bounded turn for the release overview; chunk drafts are merged per class. Any failure (no SDK, no auth, no model, timeout, session error, malformed chunk) → **deterministic fallback**: raw subjects, no overview — a malformed chunk is skipped (the caller's coverage check falls back for that group), a timeout aborts the LLM path. `--no-llm` forces the fallback.
   - Prepend `## v<x.y.z> — YYYY-MM-DD` section to committed `CHANGELOG.md` (created on first release; full-history summary). The same section is the GitHub release notes.
6. **Confirm** (unless `--yes`): print tag, version, bump rationale, commit count, changelog preview → `y/N`.
7. **Version + build + pack**: write `<x.y.z>` into `package.json`; `bun run build` → `bun pm pack` → `omp-web-<x.y.z>.tgz`.
8. **Manifest + validate**: sha256 the tarball → `release-manifest.json` (schema above). Validate the packaged release: tarball name matches convention; contains `package/dist-bundle/cli.js`; first line is the `#!/usr/bin/env bun` shebang; the version stamp appears in the bundle; manifest sha256 matches the computed one. Artifacts move to `dist-release/` (gitignored).
9. **Stage stop**: in `--stage` mode this is the last step — write `dist-release/notes.md`, print the review summary + the `--go` command, exit 0 with nothing published. Automatic mode continues.
10. **Commit + tag + push**: `git commit -am "release: v<x.y.z>"` (package.json + CHANGELOG.md), `git tag v<x.y.z>`, `git push origin main --follow-tags`.
11. **Release**: `gh release create v<x.y.z> dist-release/omp-web-<x.y.z>.tgz dist-release/release-manifest.json --title "v<x.y.z>" --notes-file <changelog section | --notes-file manual notes>` — always a full, published (non-draft, non-prerelease) release.
12. **Verify**: retry `curl -fsSL …/releases/latest/download/release-manifest.json` until it reports the just-uploaded version (latest-resolution can lag; bounded backoff ≤ 60s); cross-check the returned sha256 against the local manifest; confirm the tarball downloads.

`--go` replays steps 10-12 from the staged state after re-validating it (stagedProblems: manifest version/sha256 consistency, tarball integrity, notes artifact presence, `CHANGELOG.md` section; tree dirty with exactly `package.json` + `CHANGELOG.md`).

Tests: `scripts/release.test.ts` — pure deterministic core only (classification, bump computation, changelog skeleton/formatting, manifest generation, validation, precondition checks, dry-run output). The LLM path is exercised as degrade-only in unit tests (fake session factory returning null/throw → fallback). The script is idempotent-safe only up to the tag step — once the tag is pushed, re-running must refuse at precondition 1.

## Risks & constraints (release-relevant)

- Asset naming convention is a hard contract: `--version x.y.z` constructs `omp-web-<x.y.z>.tgz` URLs blindly. The release script enforces it; manual releases must not.
- Manifest on a prerelease/draft poisons the `latest` channel for `update` — the release script must always create a full, published (non-draft, non-prerelease) release.
- sha256 is computed over the exact bytes uploaded; generate the manifest after packing, never before a rebuild.
- Private repo + `update` = asset downloads need a token; don't go private unless update gains auth. Public repo is the default assumption.
- `package.json` version is the single source of truth; `cli/version.ts` reads it (define stamp in the bundle). The release script is the only thing that bumps it.
- LLM changelog is best-effort by design: the deterministic skeleton + per-group fallback guarantee a valid changelog even with no model/auth/network. Never block a release on the LLM.
- Commit classification is prefix-based and imperfect (compound prefixes like `fleet+ui:` classify as `other` → patch). The classification table is printed and the target version is confirmed before tagging; explicit version arg overrides.
- Git identity is the local placeholder (`omp-web <omp-web@local>`) — release commits carry it until the user sets a real identity. Repo is MIT-licensed (`LICENSE`).

## Remaining actions (carried over from the removed release plan)

Step 2 (default the update channel to GitHub) is done — `cli/update.ts` now defaults to `GITHUB_RELEASES_BASE` and `cli/update.test.ts` asserts the fallback. Still open:

- [ ] **Push to GitHub** — `gh repo create nibblebot/omp-web --public --source . --remote origin --push` from `main` (or `--private` if preferred; asset downloads from a private repo require auth, so public is the path of least resistance for `update`). Repo name/visibility to be confirmed with the user before executing. Verify `git ls-remote origin` + `gh repo view nibblebot/omp-web`.
- [ ] **First release v0.1.0** — `bun scripts/release.ts 0.1.0 --yes --notes-file <path>`: tags `v0.1.0`, creates the release with both assets, creates `CHANGELOG.md`. Hand-written release notes recommended for the first release (a curated summary reads better than the auto changelog); the changelog section remains the `CHANGELOG.md` entry. Sanity: curl the manifest URL; confirm the tarball downloads; sha256 matches.
- [ ] **Live channel check (the real E2E)** — install v0.1.0 from the release tarball URL via the install script (sandboxed `HOME`/`BUN_INSTALL`, same shape as `scripts/test-onboard.ts` but against the real channel); verify the one-liner `curl -fsSL …/scripts/install.sh | sh` on a machine without bun installs bun, then omp-web, and `omp-web --version` prints 0.1.0; `bun scripts/release.ts` (no arg — exercises the auto-bump path) → 0.2.0 second release; `omp-web update` (no `OMP_WEB_UPDATE_URL` — exercises the GitHub default) in the sandbox → assert re-install + `omp-web --version` prints `0.2.0`; also `omp-web update --version 0.1.0` against the pinned-tag URL path.
- [ ] **CI (deferred)** — none today; the release script's local gate is the quality bar for now.
