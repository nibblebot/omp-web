---
title: Changelog
description: Where the omp-web release history lives, how each release entry is organized, and how to find breaking changes, features, and fixes without reading the whole file.
---

The omp-web release history lives in [`CHANGELOG.md`](https://github.com/nibblebot/omp-web/blob/main/CHANGELOG.md) at the root of the repository. That file is the authoritative record of what shipped in every release. This page does not reproduce it: a copy would drift as releases are added, so the site points at the source and explains how to read it.

## Where to read what

| You need | Read |
| --- | --- |
| The full release history, newest first | [`CHANGELOG.md`](https://github.com/nibblebot/omp-web/blob/main/CHANGELOG.md) on GitHub |
| One release with its notes and downloadable assets | [GitHub Releases](https://github.com/nibblebot/omp-web/releases) |
| To install a release or move to a newer one | [Updates](/operations/updates/) |
| How maintainers produce a release | [Release process](/project/release/) |

`CHANGELOG.md` wins whenever two of these disagree. GitHub Releases normally repeat the matching changelog entry, because the release command publishes that entry as the release notes; a maintainer can substitute hand-written notes for a single release, so one release page can read differently from the changelog while the changelog keeps recording what the release contains.

`docs/release.md` in the repository remains authoritative for maintainer release operations, and the [Release process](/project/release/) page is a guide to it.

## How a release entry is organized

New releases are prepended, so the newest entry is at the top. Each release opens with a level-2 heading that names the tag and release date, such as `## v0.1.1`. When the release has a summary, one overview paragraph follows the heading.

Below that, changes are grouped by kind. Only groups that contain changes appear, and they always keep this order:

1. `### Breaking changes`
2. `### Features`
3. `### Bug fixes`
4. `### Maintenance & other`

Each bullet describes one commit merged since the previous release and ends with a link to that commit on GitHub. Every commit from the release window appears in exactly one group, so an entry is a complete list of what changed rather than a curated selection.

Read `Breaking changes` before updating. It collects the commits that mark themselves as incompatible, either with a `!` in the subject or a `BREAKING CHANGE:` footer. The project is still pre-1.0, and a breaking change is clamped to a minor bump while the version is 0.x, so a release such as `v0.2.0` can contain breaking changes.

## Find the change you care about

- **Start from the version you run.** `omp-web --version` prints the installed version. Find that version in the changelog: sections newer than it are what an update would bring, and sections older than it are changes you already have.
- **Jump by group.** On GitHub, use the file outline to list every heading, or search the file for a group heading. Group headings repeat in every release, so pair the search with a version heading to land on the right entry.
- **Link to a single release.** [GitHub Releases](https://github.com/nibblebot/omp-web/releases) gives each tag its own page, which is easier to share than a heading inside a growing file, and each page also carries that release's tarball and manifest assets.
- **Search for a specific change.** Bullets are written from commit subjects, and each one links to the exact commit, so a search for a feature name or a commit hash finds the release that introduced it.

## What the changelog does not cover

- Unreleased work. There is no unreleased section: an entry appears when a release is published, not when work merges, so the top of the file always describes a tagged release.
- Upgrade steps. How to install a release, restore an earlier one, and restart the fleet and its session daemons is [Updates](/operations/updates/) material.
- Known issues and plans. Bugs in a published release belong in the repository's issue tracker, and contributor workflow is covered by [Contributing](/project/contributing/).

## Related

- [Updates](/operations/updates/): install a release, pin an older one, and restart running processes safely.
- [Release process](/project/release/): the maintainer workflow that generates each changelog entry.
- [Contributing](/project/contributing/): where changes start and how they reach a release.
