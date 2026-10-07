---
name: sdk-reconcile
description: Reconcile omp-web with the latest upstream @oh-my-pi SDK release. Bumps the seven pinned @oh-my-pi/* packages together in an isolated git worktree, reads the upstream changelog delta, adapts repo code to breaking changes, runs the release gate plus a real-daemon smoke, updates docs and changelog, and commits on a local branch. Use for "reconcile SDK", "bump SDK pins", "upgrade @oh-my-pi", or periodic SDK maintenance runs.
---

# SDK reconcile

Brings the `@oh-my-pi/*` pins up to the upstream npm latest and leaves a green, reviewable commit on a local branch. Safe to run unattended and repeatedly. Calling it twice for the same target version is a no-op the second time.

## Rules

- **Headless-safe.** Never ask the user. Whenever this procedure says stop, write the report (see Report) and end the run.
- **Never touch the invoking checkout's working tree.** All changes go into a new worktree. Never push, never open a PR, never merge.
- **Git identity comes only from the user's `.gitconfig`.** If the commit fails on identity, stop. Never set or override an identity (AGENTS.md).
- **One set.** All seven pins move to the same exact version, with no `^`, no `patchedDependencies`, no `patches/`, and no hand-edits to `node_modules`.
- **Scope.** Adapt repo code only as far as needed to keep current behavior working on the new SDK. The wire contract stays additive-only (`OMP_PROTO` unchanged). New upstream capabilities worth adopting go in the report as follow-ups, not into the branch.
- **AGENTS.md applies in full** inside the worktree: conventions, test log files, `tempDir()`, no em dashes in prose.

Inputs (optional, from the invocation text): an explicit target version (default: upstream latest) and `--base <ref>` (default: `HEAD` of the invoking checkout). Uncommitted changes in the invoking checkout are never included. Say so in the report if `git status --porcelain` is non-empty.

## 1. Detect

From the invoking checkout's root:

```sh
bun scripts/preflight.ts --json
```

Read the `sdk-pins` finding:

- **No `sdk-pins` finding**: pins are current. Report `current at <pin>` and stop.
- **`upstream npm lookup failed`**: report it and stop. Do not guess a version.
- **`pins disagree` (error)**: reconcile anyway. The target below realigns them.
- **`pinned at X, upstream latest is Y`**: `FROM = X`, `TARGET = Y` unless an explicit target was given.

Confirm that `TARGET` is published for every pinned package. If any is missing, use the highest version all seven share above `FROM`, or stop if there is none:

```sh
for p in pi-agent-core pi-ai pi-catalog pi-coding-agent pi-tui pi-utils pi-wire; do npm view "@oh-my-pi/$p@$TARGET" version; done
```

Derive the package list from `package.json` dependencies starting with `@oh-my-pi/`, not from this file. If that list differs from the seven above, use the `package.json` list and note the drift in the report.

## 2. Idempotency and isolation

```sh
BRANCH=maint/sdk-$TARGET
MAIN=$(git worktree list --porcelain | awk 'NR==1{print $2}')
WT=$MAIN.sdk-$TARGET          # sibling of the main worktree, matching omp-web.<slug>
SKILL_DIR="$(git rev-parse --show-toplevel)/.omp/skills/sdk-reconcile"   # helper scripts, resolved in the invoking checkout
```

- `git rev-parse --verify --quiet refs/heads/$BRANCH` succeeds:
  - already an ancestor of the base (`git merge-base --is-ancestor $BRANCH <base>`): report `already reconciled to $TARGET` and stop.
  - otherwise: report the existing branch and worktree (unmerged earlier run) and stop. Never create a second copy, never reset it.
- `$WT` exists but the branch does not: report it and stop.

Otherwise:

```sh
git worktree add -b "$BRANCH" "$WT" <base>
```

Every later command runs with `cwd = $WT`.

## 3. Bump

```sh
bun add --exact @oh-my-pi/pi-agent-core@$TARGET @oh-my-pi/pi-ai@$TARGET ...   # every pinned package, one command
```

Verify before moving on:

- `package.json`: every `@oh-my-pi/*` dependency is exactly `$TARGET`. No other dependency changed.
- `bun.lock`: every `@oh-my-pi/*@<version>` entry, transitive ones included (`pi-natives*`, `omptype`, `snapcompact`, `omp-stats`, `pi-mnemopi`), resolves to `$TARGET`. Any other version means the set split: report it and stop.
- No `patchedDependencies` key appeared in `package.json`.

## 4. Read the upstream delta

```sh
bun "$SKILL_DIR/changelog-delta.ts" --from $FROM > /tmp/sdk-delta-$TARGET.md
```

The first line lists the versions whose sections contain `### Breaking Changes`. Read every breaking section in full, plus the `Changed`/`Removed` entries. Skim `Added`/`Fixed` for follow-ups.

Map them onto what the repo actually uses:

- SDK import sites: grep `from "@oh-my-pi/` across `apps lib scripts e2e`. Only symbols imported here can break the build. Behavior changes can still reach any code path that calls into the SDK at runtime: sessions, settings, auth, stats, compaction, session listing.
- Version-anchored source comments: grep for the literal `$FROM` (and older pins) in `apps lib scripts`. Comments such as `apps/session/resume-import-adapter.ts` ("revalidate on bump") and `apps/session/compaction-adapter.ts` describe specific SDK behavior. Re-check each claim against the new code in `node_modules/@oh-my-pi/*/src`, fix the code if the behavior moved, then update the version literal.

## 5. Gate, cheapest first

```sh
bun run check:types
bun run lint
bun run format:check
bun run build:web
bun run test > /tmp/omp-sdk-$TARGET-test.log 2>&1   # read failures back from the log; never pipe to tail/head
bun e2e/onboarding.ts
bun "$SKILL_DIR/smoke-daemon.ts" --root "$WT"
```

This is the release gate (`GATE_COMMANDS` in `scripts/release.ts`; re-read it in case it changed) plus lint and a real-daemon smoke. `smoke-daemon.ts` boots `apps/session/index.ts` against the operator's real agent dir and auth (the suites are hermetic and never do), reads `/events` priming through `ready`, and prints JSON with `ok`, `frames`, and `sdkModel`. `sdkModel: null` means no default model resolved under the new SDK. Treat that as a regression if the same smoke on the invoking checkout returns a model.

Attribute every failure before fixing it. A failure the base commit also has is pre-existing: list it in the report and leave it alone. To check a failing test file against the base without touching the invoking checkout:

```sh
git stash push --include-untracked && bun install --frozen-lockfile
bun scripts/test.ts <failing files>
git stash pop && bun install
```

## 6. Adapt

Fix failures caused by the bump, following the AGENTS.md editing workflows. The previous bump, `ae56d3b chore(sdk): upgrade to 18.6.1 ...`, shows the typical blast radius: settings model, auth/login, stats config and sync, session lifecycle, and their tests.

- Prefer the SDK's new API over re-implementing removed behavior locally.
- Update or delete tests that pinned old SDK incidentals. Keep tests that pin consumer-visible behavior.
- **Upstream regression** (the SDK is wrong, not the repo): do not work around it. Leave the worktree uncommitted, report the evidence (failing command, SDK source location, changelog entry), and stop.
- Re-run the full gate after the last fix, not just the files you touched.

## 7. Docs and changelog

- `AGENTS.md`: the "SDK pins" bullet's version, plus any statement the new SDK made false.
- `CHANGELOG.md`, `## Unreleased`, `### Maintenance & other`: if a line `Bump all seven imported \`@oh-my-pi/*\` SDK packages together to ...` already exists there, update its version in place. Otherwise add one in that wording. Add separate entries only for consumer-visible changes the adaptation caused.
- Re-run `bun scripts/preflight.ts --json`. For each `docs-sdk-literals` finding, update literals that describe the current pin. Leave historical ones alone. For example, `docs/src/content/docs/operations/updates.md` and `reference/files.md` cite `18.2.6` as the legacy patch target of releases up to 0.2.0, which is history, not drift.
- Docs under `docs/src/content/docs/` whose described behavior changed (settings, auth, stats, environment).

## 8. Commit

```sh
git add -A
git commit -m "chore(sdk): upgrade to $TARGET" -m "<one line per adaptation; upstream breaking changes handled>"
```

Commit only when step 5 is fully green, apart from attributed pre-existing failures. Otherwise leave the worktree uncommitted and say so in the report.

## Report

End every run with this, and nothing after it:

```
SDK reconcile: <current | reconciled | blocked | already reconciled | skipped>
From → To:     <FROM> → <TARGET>
Branch/WT:     <BRANCH> at <WT> (<committed SHA | uncommitted>); other unmerged maint/sdk-* branches: <list | none>
Upstream:      <breaking sections from changelog-delta, one line each, marked relevant/not>
Changes:       <files/areas adapted and why>
Gate:          <each command → pass/fail; pre-existing failures named>
Smoke:         <smoke-daemon JSON ok/sdkModel/frames>
Docs:          <AGENTS.md / CHANGELOG / docs pages touched>
Follow-ups:    <new SDK capabilities worth adopting; blockers with evidence>
Next:          git -C <invoking checkout> merge <BRANCH>   |   git worktree remove <WT> && git branch -D <BRANCH>
```
