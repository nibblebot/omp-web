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
4. **Gate**: the exported `GATE_COMMANDS` list, in this exact order: `bun run check:types`, `bun run format:check`, `bun run build:web`, `bun run test`, `bun scripts/test-onboard.ts`. The script stops at the first failure. (Lint is warnings-tolerant per repo convention; skip it as a gate. `build:web` runs before `test` as a fast sanity gate that the UI bundle still compiles; the test suite itself needs no built `dist/`, which is gitignored and absent on fresh worktrees. The fifth command is the offline distribution/onboarding E2E: pack, sandboxed pinned install, first-run config, bare serve, spawn, and update round trip.)
5. **Changelog** (LLM-assisted, deterministic structure):
   - Deterministic skeleton: group commits by class; every commit appears in exactly one group, bullet-per-commit, hash preserved. The LLM cannot move or drop commits (validation: each hash present in its group's bullets; a group failing validation falls back to raw subjects).
   - LLM prose: one-shot `omp -p --no-pty --no-session [--profile <p>]` subprocess turns (the binary resolves via `Bun.which("omp")`; `OMP_WEB_RELEASE_PROFILE` supplies the profile), stdout taken as the assistant text. No session daemon, no SDK import, no auth storage, no model registry. The summarizer prompts **one turn per bounded chunk** (≤15 commits; long structured JSON output degrades on big histories) plus one final bounded turn for the release overview; chunk drafts are merged per class. Any failure (no `omp` binary, non-zero exit, timeout, malformed chunk) → **deterministic fallback**: raw subjects, no overview. A malformed chunk is skipped (the caller's coverage check falls back for that group), a timeout aborts the LLM path. `--no-llm` forces the fallback.
   - Prepend `## v<x.y.z>, YYYY-MM-DD` section to committed `CHANGELOG.md` (created on first release; full-history summary). The same section is the GitHub release notes.
6. **Confirm** (unless `--yes`; skipped in `--stage` mode, which stops after validation): print the tag, repo and commit count, then prompt `y/N`. The version and bump rationale print during step 3; the changelog preview prints only under `--dry-run`.
7. **Version + build + pack**: write `<x.y.z>` into `package.json`; `bun run build` → `bun pm pack` → `omp-web-<x.y.z>.tgz`.
8. **Manifest + validate**: sha256 the tarball → `release-manifest.json` (schema above). Validate the packaged release: tarball name matches convention; contains `package/dist-bundle/cli.js`; first line is the `#!/usr/bin/env bun` shebang; the version stamp appears in the bundle; manifest sha256 matches the computed one. Then the **packed-tarball smoke** (`smokePackedTarball(tgzPath, version)`): install the packed tarball for real with `bun scripts/install-omp-web.ts <abs tgz> --prefix <sandbox>/datahome --bin-dir <sandbox>/bin` inside a tracked `mkdtemp` sandbox under the system temp dir, with `HOME=<sandbox>/home` and `BUN_INSTALL=<sandbox>/bun` pointed inside that sandbox so the installer's global-removal path can never touch the operator's real global install, then run `<sandbox>/bin/omp-web --version` and require stdout, trimmed, to equal the release version exactly. The sandbox is always removed, success or failure. A smoke failure throws and stops the run: the tarball is the thing being published, so it must install and report its own version. Artifacts move to `dist-release/` (gitignored).
9. **Stage stop**: in `--stage` mode this is the last step. Write `dist-release/notes.md`, print the review summary + the `--go` command, exit 0 with nothing published. Automatic mode continues.
10. **Commit + tag + push**: `git add package.json CHANGELOG.md` then `git commit -m "release: v<x.y.z>"`, `git tag v<x.y.z>`, `git push origin main --follow-tags`.
11. **Release**: `gh release create v<x.y.z> dist-release/omp-web-<x.y.z>.tgz dist-release/release-manifest.json --repo nibblebot/omp-web --title "v<x.y.z>" --notes-file dist-release/notes.md`. Always a full, published (non-draft, non-prerelease) release.
12. **Verify**: retry `curl -fsSL …/releases/latest/download/release-manifest.json` until it reports the just-uploaded version (latest-resolution can lag; up to 12 attempts, five seconds apart); cross-check the downloaded tarball's sha256 against the manifest it just served; confirm the tarball downloads.

`--go` replays steps 10-12 from the staged state after re-validating it (stagedProblems: manifest version/sha256 consistency, tarball integrity, notes artifact presence, `CHANGELOG.md` section; tree changes limited to `package.json` (optional) and `CHANGELOG.md` (required)), plus branch, `gh` auth, `origin` and tag absence. In `publishStaged`, the packed-tarball smoke runs again once the staged checks pass (after the optional confirmation prompt) and before the commit, tag and push, so the artifacts that are actually published are the ones that just installed cleanly.

Tests: `scripts/release.test.ts`: pure deterministic core only (classification, bump computation, changelog skeleton/formatting, manifest generation, validation, precondition checks, argument parsing, staged-artifact and staged-tree validation). The LLM path is degrade-tested in `scripts/release-llm.test.ts` through the spawn seam (non-zero exit, throw, timeout → fallback). The script is idempotent-safe only up to the tag step. Once the tag is pushed, re-running must refuse at the tag check (the tag exists locally and on origin).

## Preflight: `scripts/preflight.ts` (advisory, standalone)

`bun scripts/preflight.ts [--strict] [--json] [--offline]` reports release drift. Run it before cutting a release. It is standalone by decision: `scripts/release.ts` does not call it, so a finding never blocks a release run by itself.

Exit codes: 0 when the report is clean; 1 when any finding has severity `error`; and 1 when `--strict` is passed and the report contains warnings. Every finding is `error` or `warn`.

Errors (the checkout is internally inconsistent):

- the seven `@oh-my-pi/*` pins in `package.json` disagree with each other (they are one set and move together);
- the root `patchedDependencies` map and `patches/` disagree: a map key with no patch file, a patch file that no key references, or a key whose version suffix is not that package's own pin;
- `package.json` and `bun.lock` disagree about `patchedDependencies`.

Warnings (drift that is not a broken release by itself):

- the pinned `@oh-my-pi/*` versions are behind the upstream npm latest;
- commits are unpushed relative to `origin/main` (the release pushes to `origin/main`, and Pages builds the site from `main`, so unpushed commits also leave the published site stale);
- `gh` is not authenticated;
- an unchecked Markdown task box in `docs/*.md` or `docs/src/content/docs/**/*.md` (line-anchored task items; prose that quotes the box syntax is not a finding, and `docs/clone-plan.md` is excluded because its boxes are the live clone-phase tracker);
- a relative link in the docs resolves to no file;
- a documented gate list disagrees with `GATE_COMMANDS` in `scripts/release.ts`;
- a stale SDK version literal in a docs page (the frozen clone design and ledger docs, `docs/clone-*.md`, are excluded: they record design-time SDK facts by charter).

`--offline` never invokes npm: the two npm-backed checks (pins behind upstream latest, stale SDK version literals) report as skipped, and every other check still runs. `--json` prints the whole report as one JSON object on stdout instead of the text report; usage errors go to stderr in either mode. (This is the repository script; `omp-web preflight --profile <id>` is the unrelated provider-profile check in the CLI.)

## Risks & constraints (release-relevant)

- Asset naming convention is a hard contract: `--version x.y.z` constructs `omp-web-<x.y.z>.tgz` URLs blindly. The release script enforces it; manual releases must not.
- Manifest on a prerelease/draft poisons the `latest` channel for `update`. The release script must always create a full, published (non-draft, non-prerelease) release.
- sha256 is computed over the exact bytes uploaded; generate the manifest after packing, never before a rebuild.
- Private repo + `update` = asset downloads need a token; don't go private unless update gains auth. Public repo is the default assumption.
- `package.json` version is the single source of truth; `cli/version.ts` reads it (define stamp in the bundle). The release script is the only thing that bumps it.
- LLM changelog is best-effort by design: the deterministic skeleton + per-group fallback guarantee a valid changelog even with no model/auth/network. Never block a release on the LLM.
- Commit classification is prefix-based and imperfect (compound prefixes like `fleet+ui:` classify as `other` → patch). The classified commits and their counts are printed and the target version is confirmed before tagging; explicit version arg overrides.
- Git identity comes from the operator's Git configuration; the script never sets or overrides one. Repo is MIT-licensed (`LICENSE`).
- The packed-tarball smoke is the only proof that the asset being published installs and reports its own version. It is deliberately sandboxed (`mkdtemp`, `HOME` and `BUN_INSTALL` inside the sandbox), so it can never touch the operator's real global install; do not "simplify" it into an install against a real prefix or a shared store.
- Preflight is advisory: the orchestrator never calls it, so a release can run with error and warning findings present. Read the report and judge; do not treat a green preflight as a substitute for the gate, or a red one as a release blocker by itself.

## Release history and CI

The repository is public. `v0.1.0` and `v0.1.1` shipped on 2026-08-20, and the stable latest-download manifest serves `0.1.1`. The release workflow is documented in `docs/src/content/docs/project/release.md` and implemented by `scripts/release.ts`.

The live channel is verified by the release script only as far as the manifest poll in step 12. A full live-channel walk (install from the real release URL, then `omp-web update` against the real channel) has no recorded result: `bun scripts/test-onboard.ts` exercises install and update against local fixtures, and the packed-tarball smoke installs the local artifact. Treat that path as unproven until someone records it.

There is no product CI. The only workflow is `.github/workflows/docs.yml`, which builds the Starlight site from `docs/` and deploys it to GitHub Pages on every push to `main` that touches `docs/**`, `package.json`, `bun.lock`, or the workflow itself; nothing else runs on push or pull request. The release script's local gate plus its validation and smoke steps are the quality bar for a release.
