# omp-web: releases & distribution

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
- sha256 verification against the manifest happens before `bun add` (tarball installs carry no registry integrity metadata; it's our job).
- `releases/latest/download/<asset>` always redirects to the newest release: **never attach the manifest to drafts or prereleases**, or `update` will offer them.
- `cli/update.ts` defaults the channel to `GITHUB_RELEASES_BASE` (`https://github.com/nibblebot/omp-web/releases/latest/download`); `OMP_WEB_UPDATE_URL` overrides it (the local E2E and tests use the override).

## Release orchestrator: `scripts/release.ts`

One command: `bun scripts/release.ts [<x.y.z>] [--dry-run] [--yes] [--no-llm] [--notes-file <path>] [--stage | --go]`. No version arg → **compute the bump** from commit classification. `<x.y.z>` → explicit version (overrides the computed bump). `--dry-run` → skip the gate, run the preconditions, commit review and changelog, print the plan, touch nothing. `--notes-file <path>` → use a hand-written markdown file as the GitHub release notes instead of the changelog section (the changelog is still generated, committed to `CHANGELOG.md`, and used everywhere else; the flag only replaces what `gh release create --notes-file` gets). `--go` publishes the staged release: it takes no version argument, no `--no-llm`, and no `--notes-file` (edit `dist-release/notes.md` instead).

**Two release modes**: `--yes` (or interactive confirm) = fully automatic: generate, validate, publish in one run. `--stage` = generate + validate everything (version write, `CHANGELOG.md`, tarball, manifest, notes, packaged-release checks) and **stop before publishing**; review `CHANGELOG.md` + `dist-release/*` (edit `dist-release/notes.md` to change the GitHub notes), then `bun scripts/release.ts --go [--yes]` publishes the staged artifacts (re-validates the staged state: tree changes limited to `package.json` (optional) and `CHANGELOG.md` (required), manifest version/sha256 consistency, tarball integrity, changelog section present, plus branch, `gh` auth, `origin` and tag absence; refuses anything else). A re-run of `--stage` on a staged tree fails the clean-tree precondition with a `--go` hint. Steps, failing fast in order:

1. **Preconditions**: clean working tree; on the default branch (`main`); `gh` CLI present and authed; an `origin` remote exists (the tag check, the push and the `gh` repo pinning all assume it). The tag-absence check for `v<x.y.z>` (local and origin) and the version checks run once the target version is known, after step 3.
2. **Review commits since previous release** (deterministic): `git log <prev-tag>..HEAD` (the prev tag comes from `git describe --tags --abbrev=0 --match "v*"`; no prev tag → all commits). Classify each commit: `BREAKING CHANGE` anywhere in subject or body, or a `type!:`/`type(scope)!:` subject → breaking; `feat:`/`feat(scope):` → feat; `fix:` → fix; everything else (`docs:`, `chore:`, `refactor:`, `test:`, compound `fleet+ui:`, `ui:`, untyped subjects) → other. Print each classified commit with its hash plus a counts line.
3. **Bump**: breaking → major; any feat → minor; else patch, with a computed major clamped to minor while the current version is `0.x.y` (pass the version explicitly to reach `1.0.0`). No version arg: apply to the current `package.json` version (first release: no `v*` tag → keep that current version). Explicit arg wins, and a target that is not newer than the current version fails. Show the computed target (the tag itself prints in the dry-run and confirm summaries).
4. **Gate**: `bun run check:types`, `bun run format:check`, `bun run build:web`, `bun run test`. (Lint is warnings-tolerant per repo convention; skip it as a gate. `build:web` runs before `test` as a fast sanity gate that the UI bundle still compiles; the test suite itself needs no built `dist/`, which is gitignored and absent on fresh worktrees.)
5. **Changelog** (LLM-assisted, deterministic structure):
   - Deterministic skeleton: group commits by class; every commit appears in exactly one group, bullet-per-commit, hash preserved. The LLM cannot move or drop commits (validation: each hash present in its group's bullets; a group failing validation falls back to raw subjects).
   - LLM prose: one-shot `omp -p --no-pty --no-session [--profile <p>]` subprocess turns (the binary resolves via `Bun.which("omp")`; `OMP_WEB_RELEASE_PROFILE` supplies the profile), stdout taken as the assistant text. No session daemon, no SDK import, no auth storage, no model registry. The summarizer prompts **one turn per bounded chunk** (≤15 commits; long structured JSON output degrades on big histories) plus one final bounded turn for the release overview; chunk drafts are merged per class. Any failure (no `omp` binary, non-zero exit, timeout, malformed chunk) → **deterministic fallback**: raw subjects, no overview. A malformed chunk is skipped (the caller's coverage check falls back for that group), a timeout aborts the LLM path. `--no-llm` forces the fallback.
   - Prepend `## v<x.y.z>, YYYY-MM-DD` section to committed `CHANGELOG.md` (created on first release; full-history summary). The same section is the GitHub release notes.
6. **Confirm** (unless `--yes`; skipped in `--stage` mode, which stops after validation): print the tag, repo and commit count, then prompt `y/N`. The version and bump rationale print during step 3; the changelog preview prints only under `--dry-run`.
7. **Version + build + pack**: write `<x.y.z>` into `package.json`; `bun run build` → `bun pm pack` → `omp-web-<x.y.z>.tgz`.
8. **Manifest + validate**: sha256 the tarball → `release-manifest.json` (schema above). Validate the packaged release: tarball name matches convention; contains `package/dist-bundle/cli.js`; first line is the `#!/usr/bin/env bun` shebang; the version stamp appears in the bundle; manifest sha256 matches the computed one. Artifacts move to `dist-release/` (gitignored).
9. **Stage stop**: in `--stage` mode this is the last step. Write `dist-release/notes.md`, print the review summary + the `--go` command, exit 0 with nothing published. Automatic mode continues.
10. **Commit + tag + push**: `git add package.json CHANGELOG.md` then `git commit -m "release: v<x.y.z>"`, `git tag v<x.y.z>`, `git push origin main --follow-tags`.
11. **Release**: `gh release create v<x.y.z> dist-release/omp-web-<x.y.z>.tgz dist-release/release-manifest.json --repo nibblebot/omp-web --title "v<x.y.z>" --notes-file dist-release/notes.md`. Always a full, published (non-draft, non-prerelease) release.
12. **Verify**: retry `curl -fsSL …/releases/latest/download/release-manifest.json` until it reports the just-uploaded version (latest-resolution can lag; up to 12 attempts, five seconds apart); cross-check the downloaded tarball's sha256 against the manifest it just served; confirm the tarball downloads.

`--go` replays steps 10-12 from the staged state after re-validating it (stagedProblems: manifest version/sha256 consistency, tarball integrity, notes artifact presence, `CHANGELOG.md` section; tree changes limited to `package.json` (optional) and `CHANGELOG.md` (required)), plus branch, `gh` auth, `origin` and tag absence.

Tests: `scripts/release.test.ts`: pure deterministic core only (classification, bump computation, changelog skeleton/formatting, manifest generation, validation, precondition checks, argument parsing, staged-artifact and staged-tree validation). The LLM path is degrade-tested in `scripts/release-llm.test.ts` through the spawn seam (non-zero exit, throw, timeout → fallback). The script is idempotent-safe only up to the tag step. Once the tag is pushed, re-running must refuse at the tag check (the tag exists locally and on origin).

## Risks & constraints (release-relevant)

- Asset naming convention is a hard contract: `--version x.y.z` constructs `omp-web-<x.y.z>.tgz` URLs blindly. The release script enforces it; manual releases must not.
- Manifest on a prerelease/draft poisons the `latest` channel for `update`. The release script must always create a full, published (non-draft, non-prerelease) release.
- sha256 is computed over the exact bytes uploaded; generate the manifest after packing, never before a rebuild.
- Private repo + `update` = asset downloads need a token; don't go private unless update gains auth. Public repo is the default assumption.
- `package.json` version is the single source of truth; `cli/version.ts` reads it (define stamp in the bundle). The release script is the only thing that bumps it.
- LLM changelog is best-effort by design: the deterministic skeleton + per-group fallback guarantee a valid changelog even with no model/auth/network. Never block a release on the LLM.
- Commit classification is prefix-based and imperfect (compound prefixes like `fleet+ui:` classify as `other` → patch). The classified commits and their counts are printed and the target version is confirmed before tagging; explicit version arg overrides.
- Git identity comes from the operator's Git configuration; the script never sets or overrides one. Repo is MIT-licensed (`LICENSE`).

## Remaining actions (carried over from the removed release plan)

Historical record. These items predate the shipped releases: the repository is public and v0.1.0 plus v0.1.1 are tagged with `CHANGELOG.md` and the live manifest in place, so treat the list below as history rather than pending work. Two items are not evidenced by an artifact: the live-channel end-to-end check left no recorded result, and CI remains deferred (`.github/` holds issue templates plus the docs-deploy workflow in `.github/workflows/docs.yml`, and `AGENTS.md` records that there is no product CI). The current release workflow is documented in `docs/src/content/docs/project/release.md` and implemented by `scripts/release.ts`.

Step 2 (default the update channel to GitHub) is done. `cli/update.ts` now defaults to `GITHUB_RELEASES_BASE` and `cli/update.test.ts` asserts the fallback. Originally still open:

- [ ] **Push to GitHub**: `gh repo create nibblebot/omp-web --public --source . --remote origin --push` from `main` (or `--private` if preferred; asset downloads from a private repo require auth, so public is the path of least resistance for `update`). Repo name/visibility to be confirmed with the user before executing. Verify `git ls-remote origin` + `gh repo view nibblebot/omp-web`.
- [ ] **First release v0.1.0**: `bun scripts/release.ts 0.1.0 --yes --notes-file <path>`: tags `v0.1.0`, creates the release with both assets, creates `CHANGELOG.md`. Hand-written release notes recommended for the first release (a curated summary reads better than the auto changelog); the changelog section remains the `CHANGELOG.md` entry. Sanity: curl the manifest URL; confirm the tarball downloads; sha256 matches.
- [ ] **Live channel check (the real E2E)**: install v0.1.0 from the release tarball URL via the install script (sandboxed `HOME`/`BUN_INSTALL`, same shape as `scripts/test-onboard.ts` but against the real channel); verify the one-liner `curl -fsSL …/scripts/install.sh | sh` on a machine without bun installs bun, then omp-web, and `omp-web --version` prints 0.1.0; `bun scripts/release.ts` (no arg; exercises the auto-bump path) → 0.2.0 second release; `omp-web update` (no `OMP_WEB_UPDATE_URL`; exercises the GitHub default) in the sandbox → assert re-install + `omp-web --version` prints `0.2.0`; also `omp-web update --version 0.1.0` against the pinned-tag URL path.
- [ ] **CI (deferred)**: no product CI today (the docs workflow deploys the docs site only); the release script's local gate is the quality bar for now.
