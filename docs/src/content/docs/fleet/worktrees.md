---
title: Create and adopt worktrees
description: "Give a project a second checkout: create a managed worktree under the workspace root, or adopt an existing linked worktree, and know which one the fleet can delete."
---

A linked Git worktree lets one repository host several branches at once, and each worktree can run its own session daemon. This page covers the two ways to add one to a project in the browser: creating a fleet-managed worktree, and adopting a linked worktree that already exists. For the underlying model, see [Projects, worktrees, session daemons, and sessions](/concepts/projects-worktrees-session-daemons-sessions/).

Worktree management is a fleet-mode browser workflow. Single-session mode has no project groups and no add-worktree dialog.

## Managed worktrees and where they live

A worktree created through omp-web is **managed**: it is a linked worktree whose realpath sits under the fleet workspace directory.

- The default workspace root is `~/.omp-web/workspaces`. The `--workspace-dir` flag wins over the `OMP_FLEET_WORKSPACE_DIR` environment variable, which wins over the `workspaceDir` key in `~/.omp-web/config.json`, which wins over the default. See the [files reference](/reference/files/) and the [configuration reference](/reference/configuration/) for exact precedence and locations.
- Managed worktrees are laid out as `<workspaceDir>/<repo-basename>/<name>`, where the name is slugified: lowercase, runs of non-alphanumeric characters collapse to a single `-`, and leading and trailing dashes are trimmed. A name that slugifies to nothing becomes `worktree`, so `Feature Branch` lands in `feature-branch`.
- If a directory with that slug already belongs to a different repository, the fleet appends a short hash suffix derived from the repository path, keeping the repository's workspace directory unique. The marker file `.omp-web-repo` in that directory records which repository owns it.
- The workspace root and the repository directory are created lazily, on your first worktree creation, not at fleet boot.

An **adopted** worktree is a linked worktree that already exists elsewhere on disk, for example `~/code/app-hotfix`. Adoption registers it with the project and creates the roster row, but the fleet does not own the directory, so it cannot delete it. Ownership is decided by the realpath check under the workspace root, not by how the worktree was added.

## Create a worktree

In the fleet sidebar, expand the project group and click **+ Add worktree**. The **Add worktree** dialog opens on the **Create new** tab.

1. Enter a name in the `name` field (placeholder `feature/…`). The name becomes the branch name unless you choose an existing branch.
2. Under **Branch**, leave **+ New branch** selected to create a branch, or pick a branch from the **use an existing branch…** dropdown.
3. Leave **Start a session now** checked (the default) to spawn a session daemon on the new worktree, or clear it to register the row asleep.
4. Click **Create worktree**. With a start requested, the dialog tracks **creating worktree**, **spawning daemon**, and **attaching session**; without one it closes as soon as the worktree is registered.

### New branch or existing branch

- **New branch** creates the branch from a base commit. The base is the origin remote's default branch when the repository has one, otherwise the checkout's current branch, otherwise `HEAD`. The fleet never fetches, so the base is whatever your local repository already knows. The `--base <ref>` CLI flag overrides it.
- **Existing branch** checks out that branch in the new worktree instead of creating one. The dropdown lists local branches alphabetically, with branches already checked out in any worktree of the repository pushed to the end and disabled, each rendered with a `(checked out)` suffix. Git refuses to check out the same branch in two worktrees, so those entries cannot be selected.

Refusals you can hit on submit:

- `worktree target already exists: <path>`: a directory already occupies the managed path. Remove it, or choose a different worktree name.
- `branch is already checked out elsewhere: <branch>`: the branch is checked out in another worktree of the same repository. Pick another branch or create a new one.
- `unknown branch: <branch>`: the branch disappeared between listing and submit, or the ref does not exist.
- `git worktree add failed: <reason>`: Git rejected the operation, for example an unusable base ref.

## Adopt an existing worktree

Switch the dialog to the **Add existing** tab. It lists the project's linked worktrees that Git knows about but no roster row uses yet.

- Rows show the worktree directory name, its current branch when known, and the full path as a tooltip. Worktrees that already have a roster row are excluded, and a worktree reachable from two registered repositories is listed once.
- If a listing fails, for example because a project stopped being a repository, that project contributes no rows instead of an error.
- **or pick a directory…** opens the same directory browser used by **Add repo** if the worktree is not listed. A picker-chosen path that matches no row is echoed as **Selected: &lt;path&gt;**.
- Click **refresh** to re-run discovery and clear the current selection.

Select a row or a directory and click **Add worktree**. Validation runs before anything is registered:

- The path must resolve to an existing directory, otherwise `not a directory: <path>`.
- It must be a linked worktree of the selected project, not its main checkout, otherwise `not a linked worktree of <project>: <path>`. A worktree of a different repository is not adoptable here; register that repository as its own project first.
- Its realpath must not belong to an existing roster row, otherwise `worktree already registered: <path>`.

Adoption is not restricted to the workspace root. An out-of-tree linked worktree registers with its own path and appears as an unmanaged row that the fleet will not delete.

## What the roster shows afterward

Both flows create one roster entry per worktree.

- The entry is nested under the project group and titled by its branch, falling back to the directory name. Worktree rows never show the full directory; the path is available from the tooltip and from **Daemon details**.
- Without a session start, the entry is registered asleep and is wakeable at any time; see [Start, stop, wake, and remove session daemons](/fleet/session-daemon-operations/).
- The main-checkout row is the project's default workspace and is never created under the workspace root.
- The row, its path, and its Git facts persist in the fleet state file, and the directory is a normal Git worktree. Restarting the fleet never recreates, moves, or renames a worktree; the row simply comes back asleep.

Failures are staged. If a worktree is created but its session daemon fails to start, the worktree itself stays registered, so it appears in the **Add existing** tab and can be started later. Creation, registration, and session start are separate steps.

## CLI equivalents

These commands drive the same control plane as the browser; they are fleet-only and are documented with their full flags in the [CLI reference](/reference/cli/). `<project>` accepts a project id, a canonical path, or a repository basename.

- `omp-web add-worktree <project> <name> [--base ref] [--branch existing] [--no-start]` creates a managed worktree. Unlike the browser dialog, the CLI starts a session daemon by default and `--no-start` opts out.
- `omp-web add-worktree <project> --existing <path> [--no-start]` adopts an existing linked worktree.
- The CLI has no separate command for editing a worktree. Choose different flags, or delete and recreate the managed worktree as described in [Safely delete managed worktrees](/fleet/delete-worktrees/).

## Related

- [The fleet sidebar](/fleet/sidebar/) explains how main-checkout and worktree rows differ on screen.
- [Register and remove projects](/fleet/projects/)
- [Safely delete managed worktrees](/fleet/delete-worktrees/)
- [Files and directories](/reference/files/)
