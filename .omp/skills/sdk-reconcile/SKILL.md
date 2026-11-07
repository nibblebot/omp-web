---
name: sdk-reconcile
description: Reconcile omp-web with the latest upstream @oh-my-pi SDK release. Bumps the seven pinned @oh-my-pi/* packages together in an isolated git worktree, triages every upstream changelog entry (breaking changes, removals, deprecations, fixes, features) plus a snapshot diff of the SDK surface omp-web mirrors (settings, builtin slash commands, tools), adapts repo code, decides with the user which new capabilities and settings get web surface, runs the release gate plus a real-session smoke, updates docs and changelog, and commits on a local branch. Use for "reconcile SDK", "bump SDK pins", "upgrade @oh-my-pi", or periodic SDK maintenance runs.
---

# SDK reconcile

Brings the `@oh-my-pi/*` pins up to the upstream npm latest, accounts for every upstream change, and leaves a green, reviewable branch: one compatibility commit, then one commit per adopted capability. Calling it twice for the same target version is a no-op the second time.

## Rules

- **Ask when it matters.** Use the `ask` tool for every decision this file marks **Ask**, and for anything else that needs the user's judgment (product scope, dropping user-visible behavior, an ambiguous classification). Never ask what tools can answer: read the code, the changelog, and the SDK source first, and put that evidence in the option descriptions. Batch related questions into one `ask` call at the checkpoints below; give each option a short label and its tradeoff in `description`; set `recommended` to the option the decision rules pick.
- **Headless fallback.** When the invocation says `--headless`/unattended, or `ask` is unavailable (for example inside a subagent), never block: take the **Default** named at each decision point, and list every decision taken that way under `Decisions` in the report as `default: <choice> (would have asked: <question>)`.
- **Never touch the invoking checkout's working tree.** All changes go into a new worktree. Never push, never open a PR, never merge.
- **Git identity comes only from the user's `.gitconfig`.** If the commit fails on identity, stop. Never set or override an identity (AGENTS.md).
- **One set.** All seven pins move to the same exact version, with no `^`, no `patchedDependencies`, no `patches/`, and no hand-edits to `node_modules`.
- **Two tiers of scope.**
  - *Compatibility* (always): keep current behavior working on the new SDK, keep the checked-in SDK mirrors truthful (settings layout, builtin mirror, version-anchored comments), migrate off removed and deprecated APIs, and drop local workarounds that an upstream fix made dead.
  - *Surface* (only with approval): new web capabilities, commands, tool cards, or settings controls, each approved through **Ask** (or deferred by the headless default) and committed separately.
- **Wire stays additive.** `OMP_PROTO` and `OMP_CALLBACK_PROTO` never change in this skill. A capability that needs a version bump or a non-additive wire change is deferred, with the reason.
- **AGENTS.md applies in full** inside the worktree: conventions, delegation, test log files, `tempDir()`, stories for component changes, no em dashes in prose.

Inputs (optional, from the invocation text): an explicit target version (default: upstream latest), `--base <ref>` (default: `HEAD` of the invoking checkout), `--headless`. Uncommitted changes in the invoking checkout are never included. Say so in the report if `git status --porcelain` is non-empty.

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

Derive the package list from `package.json` dependencies starting with `@oh-my-pi/`, not from this file. If it differs from the seven in AGENTS.md, use the `package.json` list and note the drift in the report. Confirm `TARGET` is published for every package:

```sh
for p in <each @oh-my-pi package>; do npm view "$p@$TARGET" version; done
```

If any is missing, the candidate is the highest version all of them share above `FROM`; stop if there is none.

**Ask** (only when one applies; otherwise proceed silently):
- `TARGET` crosses a major version from `FROM`: options `latest major` / `highest version within FROM's major` / `stop`. **Default:** latest major.
- `TARGET` is not the npm latest because a package lags: options `shared version <V>` / `stop and wait`. **Default:** shared version.

## 2. Idempotency and isolation

```sh
BRANCH=maint/sdk-$TARGET
MAIN=$(git worktree list --porcelain | awk 'NR==1{print $2}')
WT=$MAIN.sdk-$TARGET          # sibling of the main worktree, matching omp-web.<slug>
SKILL_DIR="$(git rev-parse --show-toplevel)/.omp/skills/sdk-reconcile"   # helper scripts, resolved in the invoking checkout
OUT=/tmp/omp-sdk-$TARGET      # scratch: snapshots, delta, ledger, logs (never committed)
```

- `refs/heads/$BRANCH` exists and is an ancestor of the base (`git merge-base --is-ancestor $BRANCH <base>`): report `already reconciled to $TARGET` and stop.
- `refs/heads/$BRANCH` exists, unmerged: **Ask** with options `resume in the existing worktree` (pick up at the first step whose output is missing; read its commits first) / `stop`. Recreating it means deleting the user's branch: offer `delete and recreate` only with that stated in its description, and run it only on an explicit pick. **Default:** stop.
- `$WT` exists but the branch does not: report it and stop.

Otherwise:

```sh
git worktree add -b "$BRANCH" "$WT" <base>
mkdir -p "$OUT"
```

Every later command runs with `cwd = $WT`. Snapshot the surface on the old SDK before bumping:

```sh
bun install --frozen-lockfile
bun "$SKILL_DIR/surface-snapshot.ts" --root "$WT" > "$OUT/surface-before.json"
```

## 3. Bump

```sh
bun add --exact <every @oh-my-pi package>@$TARGET   # one command
bun "$SKILL_DIR/surface-snapshot.ts" --root "$WT" > "$OUT/surface-after.json"
bun "$SKILL_DIR/surface-snapshot.ts" --diff "$OUT/surface-before.json" "$OUT/surface-after.json" > "$OUT/surface-delta.md"
```

Verify before moving on:

- `package.json`: every `@oh-my-pi/*` dependency is exactly `$TARGET`. No other dependency changed.
- `bun.lock`: every `@oh-my-pi/*@<version>` entry, transitive ones included (`pi-natives*`, `omptype`, `snapcompact`, `omp-stats`, `pi-mnemopi`), resolves to `$TARGET`. Any other version means the set split: report it and stop.
- No `patchedDependencies` key appeared in `package.json`.

## 4. Triage the upstream delta

```sh
bun "$SKILL_DIR/changelog-delta.ts" --from $FROM > "$OUT/delta.md"
bun "$SKILL_DIR/changelog-delta.ts" --from $FROM --json > "$OUT/delta.json"
```

`delta.md` opens with the breaking sections and per-category counts; `delta.json` lists every entry as `{ package, version, category, heading, text }`. `surface-delta.md` lists added, removed, and changed settings, tabs, builtins, and tools, with where each new setting lands under the current layout, stale layout or `RENDERERS` entries, and `sdkHandled` flips. Its tool list is the SDK's static built-in names (`tools/builtin-names`); tools a session registers at runtime (MCP, extensions) come only from the changelog.

Read every entry, not just the breaking ones. Write `$OUT/ledger.md`: one row per entry (and per `surface-delta` line the changelog missed), with `category`, `omp-web touchpoint` (file or `none`), `verdict`, and the evidence (a grep hit, an SDK source location, or why it does not apply). Entries the same change repeats across packages share a row. Verdicts:

|Verdict|When|Goes to|
|---|---|---|
|`compat`|The repo imports, calls, mirrors, or tests the changed thing, or runtime behavior on a repo code path changes|Step 6|
|`removal`|An API, setting, command, or tool the repo uses or exposes is gone|Step 6 (repo-internal) or Ask (user-visible)|
|`deprecation`|The repo uses a deprecated API|Step 6 when the replacement is a mechanical swap; otherwise a follow-up|
|`fix-cleanup`|An upstream fix makes a local workaround, special case, or pinned-bug test dead|Step 6|
|`surface`|A new or extended capability, setting, command, tool, event, or mode the web could expose|Step 7|
|`n/a`|Terminal-only rendering, keybindings, CLI startup/update, or an SDK area omp-web never reaches|Ledger only, with the reason|

How to find touchpoints:

- **Imports.** grep `from "@oh-my-pi/` across `apps lib scripts e2e`. Only symbols imported here break the build, but behavior changes reach any code path that calls into the SDK at runtime: sessions, settings, auth, stats, compaction, resume, session listing, subagents, collab.
- **Version-anchored comments.** grep for the literal `$FROM` (and older pins) in `apps lib scripts`. Comments such as `apps/session/resume-adapter.ts` ("revalidate on bump") and `apps/session/compaction-adapter.ts` describe specific SDK behavior. Re-check each claim against `node_modules/@oh-my-pi/*/src`, fix the code if the behavior moved, then update the literal.
- **Workarounds.** For each `Fixed` entry, grep the area it names plus `workaround|upstream|SDK bug|until the SDK` in `apps lib`. A workaround is dead only when the new SDK source proves the fix covers the case it handles; otherwise keep it and note why.
- **Surface map.** Where each SDK area meets omp-web:

|SDK area|omp-web touchpoint|
|---|---|
|Settings registry and UI metadata (`config/registry`, `config/settings-ui`, pi-tui `settings-defs`)|`lib/sdk-settings/settings-layout.ts` (`HIDDEN_SETTING_PATHS`, `ADVANCED_SETTING_PATHS`, `TAB_SECTION_ORDER`, `WEB_TRUE_CONDITIONS`); `settings-model.ts` (coercion special cases, `NEXT_SESSION_PATHS`); `apps/session/transcript-history.ts` (`settingWriteReloadsHistory`); custom controls in `apps/web/components/settings/controls/`|
|Builtin slash commands (`slash-commands/builtin-registry`)|`apps/web/prompt/sdk-builtins.ts` mirror (`sdk-builtins.test.ts` fails on drift); `command-registry.ts` kinds `local`/`forwarded`/`tui-only`; `prompt/commands.ts` `LOCAL_COMMANDS`; feature-owned commands in `apps/web/features/manifest.ts`|
|Built-in tools|`apps/web/components/chat/tools/renderers.ts` (`RENDERERS`, else `GenericToolCard`) and its design-system story|
|`AgentSession` methods|`apps/session/methods.ts` (`READ_ONLY_METHODS` in `lib/wire/protocol.ts`, `HISTORY_RELOAD`, readiness gating); additive `lib/wire/protocol.ts` shapes|
|Agent session events|`toWireEvent` in `apps/session/client-delivery.ts` (the only slimming point), web store consumers|
|Extension UI, dialogs, ask/approval flows|`apps/session/browser-ui.ts`, `apps/web/components/requests/`|
|Auth, providers, models, stats, compaction, resume|their `apps/session/*-adapter.ts` and settings/auth code; `docs/src/content/docs/`|

The previous bump, `ae56d3b chore(sdk): upgrade to 18.6.1 ...`, shows the typical compatibility blast radius: settings model, auth/login, stats config and sync, session lifecycle, and their tests.

## 5. Gate, cheapest first

```sh
bun run check:types
bun run lint
bun run format:check
bun run build:web
bun run test > "$OUT/test.log" 2>&1   # read failures back from the log; never pipe to tail/head
bun e2e/onboarding.ts
bun "$SKILL_DIR/smoke-session.ts" --root "$WT"
```

This is the release gate (`GATE_COMMANDS` in `scripts/release.ts`; re-read it in case it changed) plus lint and a real-session smoke. `smoke-session.ts` boots `apps/session/index.ts` against the operator's real agent dir and auth (the suites are hermetic and never do), reads the `/ws` browser-socket priming through `ready`, and prints JSON with `ok`, `frames`, and `sdkModel`. `sdkModel: null` means no default model resolved under the new SDK. Treat that as a regression if the same smoke on the invoking checkout returns a model.

Attribute every failure before fixing it. A failure the base commit also has is pre-existing: list it in the report and leave it alone. To check a failing test file against the base without touching the invoking checkout:

```sh
git stash push --include-untracked && bun install --frozen-lockfile
bun scripts/test.ts <failing files>
git stash pop && bun install
```

## 6. Adapt (compatibility tier)

Work through every `compat`, `removal`, `deprecation`, and `fix-cleanup` row plus every gate failure caused by the bump, following the AGENTS.md editing workflows. Delegate independent areas to subagents per AGENTS.md; each gets its ledger rows and the evidence.

- Prefer the SDK's new API over re-implementing removed behavior locally.
- **Settings mirror.** Removed rows come out of every manifest in `settings-layout.ts` (`settings-layout.test.ts` fails on stale entries). Changed type or default: re-check `coerceSettingValue` special cases and any custom control bound to the path. New rows get placed (step 7 rules) even when no other surface is adopted, because an unplaced row shows on the web by default.
- **Builtin mirror.** Bring `sdk-builtins.ts` to the new registry. A new builtin with a headless handler is `forwarded`; a terminal-only one is `tui-only` and gets a `notice` naming the web alternative when one exists. An `sdkHandled` flip changes routing: check `command-registry.ts` and `LOCAL_COMMANDS` for a local handler that now duplicates or contradicts the SDK.
- **Removals.** Repo-internal use: migrate to the replacement. **Ask** when a removal takes away something web users see or use (a settings row, a command, a tool card, a dialog, a documented behavior): options `drop it from omp-web` / `keep it with a local implementation` (state the cost and that it diverges from the TUI) / `stop the reconcile`. **Default:** drop when the changelog names a replacement, otherwise stop.
- **Fixes.** Delete dead workarounds and the tests that pinned the old bug; keep tests that pin consumer-visible behavior, and make sure one still covers the fixed path.
- Update or delete tests that pinned old SDK incidentals.
- **Upstream regression** (the SDK is wrong, not the repo): never work around it silently. **Ask** with options `stop, leave the worktree uncommitted` / `retarget to the highest earlier version without the regression` (name it, after checking its changelog) / `local workaround` (tagged comment naming the upstream version and evidence, plus a follow-up). **Default:** stop. Report the failing command, the SDK source location, and the changelog entry either way.
- Re-run the full gate after the last fix, not just the files you touched. When green (apart from attributed pre-existing failures), commit the compatibility tier:

```sh
git add -A
git commit -m "chore(sdk): upgrade to $TARGET" -m "<one line per adaptation; upstream breaking changes, removals, and fixes handled>"
```

## 7. Surface decisions

Classify every `surface` row and every new setting, builtin, and tool from `surface-delta.md`, then put the open choices to the user in one checkpoint.

### Settings placement

A new SDK row with UI metadata shows on the web in its SDK tab unless the layout says otherwise. Place each one by these rules, in order:

1. Configures terminal rendering, terminal probes, keybindings, the status line, speech or voice, CLI startup or update, or another TUI-only behavior: `HIDDEN_SETTING_PATHS`.
2. Configures something the web has no counterpart for yet: `HIDDEN_SETTING_PATHS`, and the capability becomes a `surface` candidate; the row moves out of hidden when that capability is adopted.
3. Expert tuning (timeouts, thresholds, limits, retry and concurrency knobs, internal or experimental flags) that most users never change: `ADVANCED_SETTING_PATHS`.
4. Otherwise visible in its SDK tab. If its group is new, add it to that tab in `TAB_SECTION_ORDER` where it reads naturally.

Then, for every row that stays on the web:

- Gated by a terminal capability condition the web always satisfies: add it to `WEB_TRUE_CONDITIONS` (verify with an empty-environment probe, as the existing entries were).
- Only read when a session starts: add it to `NEXT_SESSION_PATHS` with a source citation, like the existing entries.
- Changes what the transcript shows: extend `settingWriteReloadsHistory`.
- A record, list, or compound type the generic controls render poorly: candidate custom control in `components/settings/controls/` (a surface item, with a story).

### Capabilities

For each new capability (session method, event, mode, tool, command, extension UI hook, auth flow, provider feature), write one line: what a web user gets, the touchpoints from the surface map, the size (existing pattern and additive fields only / new wire frame or method / new UI area), and the risk. Then recommend:

- **Adopt in this branch**: clear value to web users, fits an existing pattern, additive wire at most, no protocol bump. Examples: a `forwarded` builtin that needs only its mirror row, a tool whose output deserves a dedicated card the way `bash`, `read`, and `edit` have one, a new read-only session method behind an existing panel.
- **New optional feature**: a whole new UI area. It enters `apps/web/features/manifest.ts` as `in-development` (off, cannot be enabled), so it can land incrementally without user exposure.
- **Track as follow-up**: valuable but large, or needs product design the user should own.
- **Skip**: terminal-only, duplicates existing web behavior, or needs a wire version bump (say so).

A new tool falls back to `GenericToolCard`, which is acceptable; propose a dedicated card only when its result is structured (diffs, tables, images, trees) and the generic card would bury it.

### Checkpoint

**Ask** once, batching every open surface question (several `ask` calls if the list is long; group related settings into one question):

- Per capability: options `adopt in this branch` / `new in-development feature` / `track as kata issue` / `skip`, with the value, size, and touchpoints in each description and the rule's pick as `recommended`.
- Settings whose placement the rules leave in doubt: options `visible` / `advanced` / `hidden`. A clear-cut row is applied without asking and listed in the report.
- Any classification you are not sure of: ask rather than guess.

**Default:** apply the settings rules (doubtful web-meaningful rows go to `advanced`); adopt nothing beyond the compatibility tier; record every capability as a follow-up in the report; create no kata issues.

## 8. Implement approved surface

Each approved item is its own slice: delegate per AGENTS.md (multi-file work goes to subagents with the ledger row, the decision, and the touchpoints), one commit per item:

```sh
git commit -m "feat(sdk): <capability> (SDK $TARGET)" -m "<what the web now exposes; ledger row>"
```

Each slice follows the repo invariants: wire additions with producers, consumers, dispatch classification, and behavior tests together; overlays through `ModalHost`; component changes with their design-system story; optional features through the feature registry. Settings placement that step 6 already committed needs no second commit. Re-run the full gate and the smoke after the last slice. A slice that cannot go green is reverted from the branch (`git revert` or dropped before commit) and reported as blocked, never committed broken.

For items the user chose to track: search first (`kata search "<terms>" --agent`), reuse an open issue if one matches, otherwise `kata create "<title>" --body "<value, size, touchpoints, SDK version, changelog entry>" --idempotency-key sdk-$TARGET-<slug> --json`.

## 9. Docs and changelog

- `AGENTS.md`: the "SDK pins" bullet's version, plus any statement the new SDK made false.
- `CHANGELOG.md`, `## Unreleased`: under `### Maintenance & other`, if a line `Bump all seven imported \`@oh-my-pi/*\` SDK packages together to ...` already exists, update its version in place; otherwise add one in that wording. Adopted surface and consumer-visible adaptations (a dropped command or setting, a behavior change) get their own entries in the matching existing section; create a section only when none fits.
- Re-run `bun scripts/preflight.ts --json`. For each `docs-sdk-literals` finding, update literals that describe the current pin. Leave historical ones alone. For example, `docs/src/content/docs/operations/updates.md` and `reference/files.md` cite `18.2.6` as the legacy patch target of releases up to 0.2.0, which is history, not drift.
- Docs under `docs/src/content/docs/` whose described behavior changed (settings, auth, stats, environment, commands) or that should mention adopted surface.

Docs changes ride in the commit of the tier or item they describe (amend the unpushed branch commit, or fold them in before committing).

## Report

End every run with this report as rendered Markdown (headings, bullets, tables, inline code), never inside a fenced code block, and nothing after it. Keep every section, in this order; write `none` for an empty one. Use one bullet per item rather than packing a section into one line, and tables where rows compare (gate commands, settings placement, commits).

- `# SDK reconcile: <current | reconciled | blocked | already reconciled | skipped>`, then one line: `<FROM>` → `<TARGET>`.
- `## Branch`: `<BRANCH>` at `<WT>`; a table of commits (SHA, subject), or `uncommitted`; other unmerged `maint/sdk-*` branches (list or none).
- `## Upstream`: entry counts per category; each breaking section on its own bullet, marked relevant or not relevant with the reason.
- `## Ledger`: the `$OUT/ledger.md` path; counts of compat/removal/deprecation/fix-cleanup rows handled and of n/a rows, with the one-word reasons grouped.
- `## Changes`: one bullet per area adapted and why.
- `## Settings`: a table of new rows (path, placement visible/advanced/hidden, live or next-session); removed rows; other manifest edits; changed defaults.
- `## Surface`: adopted items with their commits; new in-development features; new wire methods or fields (additive, no protocol bump).
- `## Decisions`: each question asked → answer; each headless default taken (`default: <choice> (would have asked: <question>)`); judgment calls made inside a slice.
- `## Gate`: a table of each command → pass/fail with counts; pre-existing failures named; the profile comparison when transport files changed.
- `## Smoke`: smoke-session `ok`, `sdkModel`, frames; any live exercise of new surface.
- `## Docs`: AGENTS.md, CHANGELOG, and docs pages touched.
- `## Follow-ups`: tracked kata issues; deferred capabilities with value and size; untested paths; blockers with evidence; process incidents (writes outside the worktree, recovered how).
- `## Next`: the two commands as inline code, merge (`git -C <invoking checkout> merge <BRANCH>`) or discard (`git worktree remove <WT> && git branch -D <BRANCH>`).
