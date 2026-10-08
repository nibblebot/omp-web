---
name: deps-update
description: Update every non-SDK dependency of omp-web (all direct dependencies and devDependencies except the @oh-my-pi/* pins) to its latest version in an isolated git worktree, take in-range updates as one batch and out-of-range (major) updates one group at a time, adapt repo code to breaking changes, verify the full build (types, lint, format, web build, installable bundle, docs site, tests, onboarding E2E, bundle and UI smokes), update the changelog, and commit on a local branch. Use for "update dependencies", "bump deps", "upgrade non-SDK packages", or periodic dependency maintenance runs.
---

# Non-SDK dependency update

Moves every direct non-SDK dependency to the registry `latest` and leaves a green, reviewable commit on a local branch. Safe to run unattended and repeatedly. A run with nothing outdated is a no-op.

## Rules

- **Headless-safe.** Never ask the user. Whenever this procedure says stop, write the report (see Report) and end the run.
- **Never touch the invoking checkout's working tree.** All changes go into a new worktree. Never push, never open a PR, never merge.
- **Git identity comes only from the user's `.gitconfig`.** If the commit fails on identity, stop. Never set or override an identity (AGENTS.md).
- **SDK is out of scope.** `@oh-my-pi/*` belongs to the `sdk-reconcile` skill. Never change those pins, and the `@oh-my-pi/*` entries of `bun.lock` must be byte-identical before and after. No `patchedDependencies`, no `patches/`, no `overrides`/`resolutions`, no hand-edits to `node_modules`.
- **Keep spec style.** Caret stays caret, tilde stays tilde, exact stays exact (`@typescript/native-preview` is pinned exactly on purpose). Packages stay in their section.
- **Scope.** Adapt repo code only as far as needed to keep current behavior working on the new versions. No refactors, no adopting new features. The wire contract is untouched (`OMP_PROTO` unchanged). Worthwhile new capabilities go in the report as follow-ups.
- **AGENTS.md applies in full** inside the worktree: conventions, test log files, `tempDir()`, no em dashes in prose.

Inputs (optional, from the invocation text): `--base <ref>` (default: `HEAD` of the invoking checkout), `--in-range-only` (skip step 5), and package names to exclude. Uncommitted changes in the invoking checkout are never included. Say so in the report if `git status --porcelain` is non-empty.

## 1. Plan

From the invoking checkout's root:

```sh
SKILL_DIR="$(git rev-parse --show-toplevel)/.omp/skills/deps-update"
bun "$SKILL_DIR/deps-plan.ts" > /tmp/deps-plan.json
```

`deps-plan.ts` reads `package.json` and `bun.lock`, queries the npm registry, and prints JSON:

- `sdkExcluded`: the `@oh-my-pi/*` names it skipped. `skipped`: non-semver specs (tags, URLs, `file:`), which it never touches. Report both.
- `outdated[]`: per package `installed` (locked), `inRange` (highest version the current spec allows), `latest`, `breaking` (latest is outside the spec: a semver major, a 0.x minor, or a moved exact pin), `inRangeTarget`/`breakingTarget` (the spec to write), `deprecated`, and `peerDependencies` of `latest`.
- `groups`: packages that move together (`@types/x` with `x`, a shared scope such as `@babel/*`, `astro` with `@astrojs/*`).
- `commands.inRange`: the `bun add` lines for step 4. `commands.breaking`: one `bun add` line per out-of-range package for step 5.

Stop with `current` when `outdated` is empty. A registry failure aborts the script: report it and stop. Never guess versions.

## 2. Idempotency and isolation

```sh
STAMP=$(date +%Y-%m-%d)
BRANCH=maint/deps-$STAMP
MAIN=$(git worktree list --porcelain | awk 'NR==1{print $2}')
WT=$MAIN.deps-$STAMP          # sibling of the main worktree, matching omp-web.<slug>
```

- `git rev-parse --verify --quiet refs/heads/$BRANCH` succeeds: report the existing branch and worktree (an earlier run today) and stop. Never create a second copy, never reset it.
- `$WT` exists but the branch does not: report it and stop.
- List other `maint/deps-*` branches not merged into the base (`git branch --no-merged <base> --list 'maint/deps-*'`) for the report.

Otherwise:

```sh
git worktree add -b "$BRANCH" "$WT" <base>
```

Every later command runs with `cwd = $WT`.

## 3. Baseline

Failures must be attributable, so record the base before changing anything:

```sh
bun install --frozen-lockfile
bun "$SKILL_DIR/deps-plan.ts" --sdk-lock > /tmp/deps-sdk-lock.before
```

Then run the full gate from step 6 once, logging the test suite to `/tmp/omp-deps-$STAMP-baseline.log`. Record each command's pass/fail. A command that already fails here is pre-existing: list it in the report, leave it alone, and judge later runs of it by "no new failures" (compare failing test names between logs).

## 4. In-range batch

Run every line of `commands.inRange` from the plan. These stay inside the current specs, so they should need no code changes.

Verify before moving on:

- `package.json`: only the planned packages changed, each to its `inRangeTarget`, spec style and section unchanged. No `patchedDependencies`, `overrides`, or `resolutions` key appeared.
- `bun "$SKILL_DIR/deps-plan.ts" --sdk-lock | diff /tmp/deps-sdk-lock.before -` is empty. Any difference means the SDK set moved: undo with `git checkout package.json bun.lock && bun install --frozen-lockfile`, report it, and stop.
- `bun add` output: note any peer-dependency warnings (lines mentioning `peer`). A required peer the repo actually uses and now violates is a failure to fix. Optional peers listed in the plan's `peerDependencies` (`vite-plus`, `svelte`, sass flavors, `eslint` for `eslint-plugin-solid`) are noise.

Run the full gate (step 6). Fix bump-caused failures (step 7), re-gate until green, then commit this batch:

```sh
git add -A && git commit -m "chore(deps): update non-SDK dependencies within range" -m "<name old → new, one per line>"
```

## 5. Out-of-range updates, one group at a time

Skip this step on `--in-range-only`. Otherwise take `commands.breaking`, cluster it by `groups` (members move in one `bun add`, for example `bun add -d @babel/parser@^8.0.7 @babel/types@^8.0.6`), and process each group in order:

1. **Read the delta.** Read the upstream release notes or CHANGELOG between `installed` and `latest` (`npm view <pkg> repository.url`, then the repository's releases/CHANGELOG; the package's `CHANGELOG.md` under `node_modules` after install also works). Note breaking entries.
2. **Map onto usage.** Find the repo's consumers. Grep imports across `apps lib scripts e2e docs` plus config files that load the package by name. Known consumers:

   |Package|Consumer|
   |---|---|
   |`@babel/parser`, `@babel/types`, `enhanced-resolve`|`scripts/check-lib-boundary.ts` (first half of `bun run lint`)|
   |`eslint-plugin-solid`|`.oxlintrc.json` `jsPlugins` (oxlint JS plugin, not ESLint; its ESLint peer is not installed and that is expected)|
   |`oxlint`, `oxfmt`|`bun run lint`, `bun run format[:check]`; configs `.oxlintrc.json`, `.oxfmtrc.json`|
   |`@typescript/native-preview`|`tsgo` in `bun run check:types` (exact pin)|
   |`vite`, `vite-plugin-solid`|`apps/web/vite.config.ts`, `scripts/dev.ts`, `scripts/build-omp-web.ts`|
   |`astro`, `@astrojs/*`|`docs/astro.config.mjs`, `docs/src/` (`bun run build:docs`)|
   |`solid-js`, `@tanstack/solid-virtual`, `marked`, `dompurify`, `diff` (+ `@types/diff`)|`apps/web/` runtime (markdown is always `DOMPurify.sanitize(marked.parse(...))`, `apps/web/text/`)|
   |`@types/bun`|every `tsconfig.json` type check|

   Re-derive this table from the grep if a package is missing from it.
3. **Apply** the group's `bun add` line, then repeat the step 4 checks (SDK lock diff, `package.json` scope, peers).
4. **Gate and adapt.** Run the full gate (step 6); fix bump-caused failures (step 7).
5. **Settle the group.**
   - Green: commit it alone, `chore(deps): upgrade <name> to <major>` (one line per package and per adaptation in the body).
   - Not green, and the blocker is upstream (the new version is broken, a required peer has no compatible release, or the plugin host no longer loads it) or needs work beyond keeping current behavior: revert the group (`git checkout package.json bun.lock && bun install --frozen-lockfile`, plus `git checkout -- .` for partial adaptations), record it as **deferred** with the evidence (failing command, error, upstream issue or changelog entry), and continue with the next group. Never work around an upstream bug.

A formatter bump (`oxfmt`) that changes formatting: run `bun run format`, review that the diff is formatting only, and commit it separately as `style: apply oxfmt <version>` right after the bump commit. A linter bump (`oxlint`, `eslint-plugin-solid`) that adds new errors: fix the code when the rule is right; disabling or downgrading a rule in `.oxlintrc.json` needs a one-line justification in the commit body and a mention in the report.

## 6. Gate, cheapest first

```sh
bun install --frozen-lockfile
bun run check:types
bun run lint
bun run format:check
bun run build:web
bun run build                                   # installable bundle → dist-bundle/cli.js
bun dist-bundle/cli.js --version                # bundle actually boots
bun run build:docs                              # docs site (astro/starlight)
bun run test > /tmp/omp-deps-$STAMP-<step>.log 2>&1   # read failures back from the log; never pipe to tail/head
bun e2e/onboarding.ts
```

This is the release gate (`GATE_COMMANDS` in `scripts/release.ts`; re-read it in case it changed) plus lint, the installable bundle, and the docs build, because non-SDK dependencies are mostly build tooling. After `bun run build`, `git status --porcelain apps/fleet/embedded-dist.ts` must be empty (the build restores the stub in a `finally`); if it is not, the build broke mid-way: treat it as a failure and restore the stub with `git checkout apps/fleet/embedded-dist.ts`.

**UI smoke** (whenever any `apps/web/` runtime dependency or `vite`/`vite-plugin-solid` changed, once after the last commit): start `bun run dev --no-open` as a long-lived service, wait for the runner's `ui` URL, open it in the browser tool, and confirm the fleet shell renders (roster sidebar present, no `fleet-required` notice), the browser console has no errors, and a chat transcript with markdown renders if one is available. Stop the service afterwards. Without a browser tool, fetch the `ui` URL and confirm the module graph serves (HTTP 200 for the page and its entry script), and state the visual limit in the report.

## 7. Adapt

Fix failures caused by a bump, following the AGENTS.md editing workflows.

- Attribute first: compare against the baseline (step 3). Pre-existing failures are not yours.
- Prefer the package's new API over re-implementing removed behavior locally.
- Update or delete tests that pinned incidental output of the old version (for example rendered markdown whitespace). Keep tests that pin consumer-visible behavior.
- Never suppress a type error, lint error, or failing test to get green.
- Re-run the full gate after the last fix, not just the files you touched.

## 8. Docs and changelog

- `CHANGELOG.md`, `## Unreleased`, `### Maintenance & other`: if a line starting `Update non-SDK dependencies` already exists there, rewrite it in place. Otherwise add one: `Update non-SDK dependencies: <name> <new>, ...; deferred: <name> <latest> (<reason>).` (omit the deferred clause when nothing was deferred). Add separate entries only for consumer-visible changes the adaptation caused.
- Grep `AGENTS.md`, `README.md`, `docs/*.md`, and `docs/src/content/docs/` for version literals and tool behavior of the packages that moved (for example tool names, config keys, minimum versions). Update statements the new versions made false; leave historical ones alone.
- Commit these as `docs: record dependency updates`.

## Report

End every run with this, and nothing after it:

```
Deps update:  <current | updated | partial | blocked | skipped>
Branch/WT:    <BRANCH> at <WT> (<commit SHAs | uncommitted>); other unmerged maint/deps-* branches: <list | none>
In range:     <name old → new, ...>
Majors:       <name old → new, ... | none>
Deferred:     <name installed → latest: reason + evidence | none>
Excluded:     <sdkExcluded count> @oh-my-pi/* (sdk-reconcile), skipped specs: <list | none>
Changes:      <files/areas adapted and why; lint rule changes>
Gate:         <each step-6 command → pass/fail; pre-existing failures named>
Smoke:        <bundle --version output; UI smoke result or stated limit>
Docs:         <CHANGELOG / docs pages touched>
Follow-ups:   <new capabilities worth adopting; deprecations; blockers>
Next:         git -C <invoking checkout> merge <BRANCH>   |   git worktree remove <WT> && git branch -D <BRANCH>
```
