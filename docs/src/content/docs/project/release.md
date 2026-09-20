---
title: Release process
description: Maintainer guide to the omp-web release workflows, including the exact command surface, preconditions and gates, staged review with --go, artifact contracts, channel verification, and recovery.
---

This page is for maintainers cutting an omp-web release. It covers the two workflows implemented by `scripts/release.ts`: the staged release (`--stage`, review, `--go`) and the fully automatic release (`--yes`).

The repository documents remain authoritative. [`docs/release.md`](https://github.com/nibblebot/omp-web/blob/main/docs/release.md) is the detailed load-bearing contract for the release channel, the update channel, and the orchestrator, and [`scripts/release.ts`](https://github.com/nibblebot/omp-web/blob/main/scripts/release.ts) is the executable workflow. Until that document's contents are fully migrated into this site, treat `docs/release.md` plus the script as the sources of truth: if this page disagrees with either, they win.

`docs/release.md` ends with a checklist carried over from a removed release plan. Those publishing items are historical: the repository is published, `v0.1.0` and `v0.1.1` have shipped, and the stable latest-download URL serves the newest manifest. Do not execute that checklist as current work.

## Command surface

Run the orchestrator from the repository root; there is no npm script alias:

```sh
bun scripts/release.ts [<x.y.z>] [--dry-run] [--yes] [--no-llm] [--notes-file <path>] [--stage | --go]
```

| Argument | Effect |
| --- | --- |
| `<x.y.z>` | Explicit target version. Overrides the computed bump and must be plain semver. It must be newer than `package.json`; on the first release (no `v*` tag yet) the current version is also accepted. |
| `--dry-run` | Runs the preconditions, commit review, and changelog preview, prints the plan and the commands that would run, skips the gate, and writes nothing. |
| `--yes` | Skips the interactive confirmation. Required whenever stdin is not a TTY. |
| `--no-llm` | Forces the deterministic changelog instead of the LLM-assisted one. |
| `--notes-file <path>` | Uses a hand-written markdown file as the GitHub release notes. The changelog entry is still generated and committed. |
| `--stage` | Generates and validates everything, then stops before publishing. |
| `--go` | Publishes a previously staged release. Rejects a version argument, `--no-llm`, and `--notes-file`. |

`--stage` and `--go` are mutually exclusive. A positional version may appear anywhere among the flags, and only one is accepted.

## Preconditions and gates

Before anything is written or published, the script checks, in order:

1. The working tree is clean. A tree whose only changes are `package.json` and `CHANGELOG.md` fails with a hint to run `--go` or restore the files.
2. The current branch is `main`. The publish step pushes `origin main`.
3. `gh` is installed and authenticated.
4. A remote named `origin` exists. Tag checks (`git ls-remote`) and the push use `origin`; the GitHub release itself is pinned to the `nibblebot/omp-web` repository.
5. The version is valid plain `x.y.z`. An explicit version must also be newer than the current `package.json` version; on the first release (no `v*` tag) the current version is accepted too.
6. The target tag `v<x.y.z>` does not already exist, locally or on `origin`.

The gate then runs these commands and stops at the first failure:

```sh
bun run check:types
bun run format:check
bun run build:web
bun run test
```

`build:web` runs before `test` as a fast sanity gate that the UI bundle still compiles; the gate order is unchanged. The suite no longer needs a built `dist/`, and the session daemon serves no UI. `bun run lint` is deliberately not a gate, because lint warnings do not fail the repository's lint run. The gate is skipped entirely by `--dry-run`.

## Version selection

The version normally comes from the commits since the previous `v*` tag. The script classifies each commit by subject prefix, prints the table, and applies this policy:

| Classification | Bump when this class is present |
| --- | --- |
| `!` in a `type!:`/`type(scope)!:` subject, or a `BREAKING CHANGE:` footer | major |
| `feat:` or `feat(scope):` | minor |
| `fix:` or `fix(scope):` | patch |
| Everything else (`docs:`, `chore:`, compound prefixes, untyped subjects) | patch |

The strongest class in the release window wins; a window with only `other` commits is still a patch.

While the project is at `0.x.y`, a computed major bump is clamped to minor; a deliberate `1.0.0` requires passing the version explicitly. With no previous `v*` tag (first release), the computed path keeps the current `package.json` version. Commit subjects therefore shape the release, so keep them conventional.

## Changelog and release notes

The script builds a `CHANGELOG.md` entry deterministically first: one `## v<x.y.z>, <date>` section, every commit from the release range in exactly one group, and one bullet per commit with a hash link. Group order is Breaking changes, Features, Bug fixes, Maintenance & other; empty groups are omitted.

LLM prose is layered on top when available. `scripts/release-llm.ts` runs one-shot `omp -p --no-pty --no-session` turns, one per bounded chunk of 15 commits per group plus one final overview turn, and `OMP_WEB_RELEASE_PROFILE` selects a non-default omp profile for those turns. Any failure (missing `omp` binary, non-zero exit, timeout, malformed output) degrades to raw commit subjects. A group whose draft drops a commit hash falls back to raw subjects for that group, so the committed entry always lists every commit. Pass `--no-llm` to skip the LLM path entirely.

The generated section becomes the `CHANGELOG.md` entry and, by default, the GitHub release notes. `--notes-file` replaces only the GitHub notes for one release; the changelog keeps the generated section.

## Stage, review, and publish

The two-phase workflow is the recommended path, because the artifacts are validated before anything leaves the machine:

```sh
# 1. Generate, validate, and stop. Omit the version to use the computed bump.
bun scripts/release.ts --stage

# 2. Review CHANGELOG.md and dist-release/. Edit dist-release/notes.md to change
#    the GitHub release notes for this release.

# 3. Publish the staged release.
bun scripts/release.ts --go --yes
```

Step 1 runs the preconditions, gate, changelog, build, pack, and artifact validation, then prints the review summary and exits without publishing. Step 3 revalidates everything from disk before publishing: the branch, `gh` auth, `origin`, a working tree containing exactly `package.json` and `CHANGELOG.md`, the staged manifest version and tarball name, tarball integrity, the notes artifact, the presence of the changelog section, and that the tag is still absent. Then it commits, tags, pushes, creates the GitHub release, and verifies the live channel. `--go --dry-run` prints the publish commands and changes nothing.

Re-running `--stage` on a tree that already holds a staged release fails the clean-tree precondition with the `--go` hint.

The fully automatic form skips the review stop and runs the same steps in one invocation:

```sh
bun scripts/release.ts --yes                 # computed bump
bun scripts/release.ts 0.2.0 --yes           # explicit version
```

Without `--yes` the script asks for confirmation on a TTY and refuses to continue on a non-TTY stdin.

## Artifact and update-channel contracts

Publishing always attaches exactly two assets with exact names:

- `omp-web-<x.y.z>.tgz`, produced by `bun pm pack` after `bun run build`
- `release-manifest.json`, with the shape `{ "version": "x.y.z", "tarball": "omp-web-x.y.z.tgz", "sha256": "<64 hex chars>" }`

The `sha256` is computed over the exact packed bytes, after packing. The manifest must never describe an earlier build: regenerate it whenever the tarball is rebuilt. The stable channel URL `https://github.com/nibblebot/omp-web/releases/latest/download/release-manifest.json` must resolve to the newest release; `omp-web update --version x.y.z` rewrites that base to `.../releases/download/v<x.y.z>/`. Both asset names are a hard contract, because the updater constructs them blindly.

Every release is therefore full and published, never a draft or a prerelease, or `omp-web update` would offer the wrong release or fail to find it. The gitignored `dist-release/` directory holds the staged artifacts between the two phases: `omp-web-<x.y.z>.tgz`, `release-manifest.json`, and `notes.md`.

## What validation catches

Before publishing, and again during `--go`, the script validates the packed tarball:

- the file name matches `omp-web-<x.y.z>.tgz`
- the archive contains `package/dist-bundle/cli.js`
- the first line of that entry is `#!/usr/bin/env bun`
- the bundle contains the version string
- the recomputed SHA-256 matches the manifest

After publishing, it verifies the live channel by retrying the stable manifest URL up to 12 times, five seconds apart, until it reports the new version, then downloads the tarball and cross-checks its digest against the manifest. Treat a release as done only after this step passes.

## Recovery

Every failure prints `release: error: <message>` on stderr and exits 1; the run stops at the failing step.

- Nothing has been pushed yet (gate, changelog, build, or validation failure): fix the cause and rerun. If the run wrote `package.json` and `CHANGELOG.md`, either keep them and publish with `--go`, or discard them the way the precondition hint says: `git restore package.json CHANGELOG.md`. The `dist-release/` artifacts are gitignored and are rebuilt by a fresh `--stage`.
- `--go` refuses to publish a tree with unexpected changes or invalid staged artifacts; the error names the offending paths or problems, so fix or discard them and rerun.
- The tag was pushed but the release was not created (for example, a `gh` failure or a network drop): a rerun refuses, because the tag now exists locally and on `origin`. Finish the publish by hand with the same command the script uses, then verify the channel:

  ```sh
  gh release create v<x.y.z> dist-release/omp-web-<x.y.z>.tgz dist-release/release-manifest.json \
    --repo nibblebot/omp-web --title "v<x.y.z>" --notes-file dist-release/notes.md
  curl -fsSL https://github.com/nibblebot/omp-web/releases/latest/download/release-manifest.json
  ```

- The release was created but channel verification failed: `releases/latest` resolution can lag, so check the manifest URL by hand and confirm the release page carries both assets and is published. Do not rerun the script for a tag that already exists.
- The commit, tag, or push step failed: the script never sets or overrides a Git identity, so commits use whatever identity your Git configuration resolves. If a commit fails with an unknown identity, configure your own identity and retry rather than overriding it.

## Tests and CI

`scripts/release.test.ts` covers the deterministic core: commit classification, bump computation, changelog formatting, coverage validation, manifest generation, tarball and staged-artifact validation, staged tree validation, and argument parsing. The LLM path is exercised only for its degrade behavior in unit tests. Distribution changes are additionally covered by the offline end-to-end gate `bun scripts/test-onboard.ts` (pack, pinned install, first run, bare serve, spawn, update round trip).

There is no CI. The repository's `.github/` directory holds issue templates only, so the release script's local gate and validation steps are the quality bar for a release.

## Related

- [Updates](/operations/updates/): the consumer side of the channel, including pinned installs, rollback, and process restarts.
- [Changelog](/project/changelog/): how release entries are organized in `CHANGELOG.md`.
- [Contributing](/project/contributing/): commit conventions and the repository verification workflow.
- [`docs/release.md`](https://github.com/nibblebot/omp-web/blob/main/docs/release.md): the detailed release and update channel contract.
- [`scripts/release.ts`](https://github.com/nibblebot/omp-web/blob/main/scripts/release.ts): the release orchestrator described on this page.
- [GitHub Releases](https://github.com/nibblebot/omp-web/releases): published releases and their assets.
