---
title: Register and remove projects
description: "Add a Git repository to the fleet, understand the main-checkout row it creates, and deregister projects safely."
---

A project is a Git repository registered with the fleet. Registration stores metadata only: it records the repository's canonical path and gives it a stable id such as `p1`. It never copies, moves, or modifies repository files, and it never creates a worktree. See [Projects, worktrees, session daemons, and sessions](/concepts/projects-worktrees-session-daemons-sessions/) for how a project relates to its checkouts.

Registering and removing projects is a fleet-mode browser workflow. Single-session mode has no project list and no fleet sidebar; see [Fleet and single-session modes](/concepts/runtime-modes/).

## Register a repository

1. In the fleet sidebar, click the plus button in the **Projects** header. (On a fresh install, the welcome panel's **Add your first project** button opens the same dialog.)
2. The **Add repo** dialog opens on **Project directory**, a directory browser for the machine running omp-web. Click a subdirectory row to enter it, type an absolute path or a `~` path into the input to jump there, and press **Select &lt;name&gt;** to choose the directory currently in view.
3. Submission requires a directory that contains a Git repository. When you reached the directory by clicking a listing row, a `git` chip confirms it; when the picker cannot tell, the fleet validates the path after you submit.

The full picker behavior, including its error notes and truncation limits, is documented in [Add your first project](/getting-started/add-first-project/).

### Optional fields

The collapsed **Advanced** section overrides the defaults for the project's main-checkout session daemon:

- **template** selects the spawn template used when a session daemon starts on this checkout. It defaults to `local` and is remembered on the main-checkout row.
- **labels** accepts comma-separated `k=v` pairs, for example `tag=api, env=prod`. Malformed labels are rejected at submit.

**Start a session now** is off by default. Leaving it off means registration finishes immediately and the new row is asleep. Turning it on runs register, spawn, and attach as one pipeline: the modal tracks **registering project**, **spawning daemon**, and **attaching session**, and closes once the browser attaches. If the checkout already has transcripts on disk, the `New session or resume` picker opens before the modal closes; see [Resume previous sessions](/fleet/resume-sessions/).

## What registration creates

Registration gives the repository's main checkout a roster entry, called its default workspace. An entry already mapped to that checkout is reused instead of duplicated. Worktree rows you add later nest under the project group.

- The fleet sidebar gains a collapsible group named after the repository directory. The group header tooltip carries the full checkout path.
- The group lists the main-checkout row first, then any linked worktrees, then a **+ Add worktree** action.
- Without an immediate start, that row is created asleep. Clicking it wakes the session daemon and attaches; see [Start, stop, wake, and remove session daemons](/fleet/session-daemon-operations/).
- The group header shows a start button, labeled **Start a session in &lt;project&gt;**, only while the project has no main-checkout row at all.

Projects are keyed by canonical path. Registering the same repository through a symlink, a relative path, or a different spelling resolves to the existing project rather than creating a second one. Attempting to register it again reports `project already registered: <pN>` and leaves the existing group in place.

## Remove a project

Open the project group's actions menu on its header and choose **Delete project…**, then confirm in the **Remove project** dialog.

- The dialog names the project and states that disk contents stay untouched; removal only deregisters the project.
- While any session daemon still references the project, removal is refused and the refusal names the blocking ids, for example `project p1 in use by daemons: d1, d2`. The dialog keeps the refusal on screen together with a **referenced by** list of the roster rows that carry the project id, so you can stop or remove them first. The dialog also lists the never-started main-checkout placeholder in that chip list, but the server drops that placeholder silently as part of the removal instead of treating it as a blocker.
- Once no real roster entry references the project, the removal succeeds, closes the dialog, and drops the project from the sidebar.

Removal is a metadata change only:

- Repository files, managed worktrees, and session transcripts remain on disk. A worktree directory under the workspace root is not deleted; see [Safely delete managed worktrees](/fleet/delete-worktrees/) for that separate action.
- Project ids are never reused. Removing `p1` and registering the same repository again later creates a new project with a fresh id.
- Removing a project never stops or removes session daemons. Stop or remove the blocking rows yourself first, then deregister the project.

## Persistence and restarts

Projects and their ordering live in the fleet state file, `~/.omp-web/fleet-state.json` by default. The `OMP_FLEET_STATE` environment variable points the fleet at a different state file. Locations are listed in the [files reference](/reference/files/).

- Projects keep insertion order, so the sidebar group order is stable across restarts.
- After a fleet restart, registered projects and their ids are still there. Locally spawned rows downgrade to asleep because their processes died with the old fleet, and remote rows are dialed again. No project or transcript data is lost.
- A corrupt state file is reported with its path instead of being silently replaced.

## CLI equivalents

These commands drive the same control plane as the browser; they are fleet-only. Full signatures and flags live in the [CLI reference](/reference/cli/).

- `omp-web add-repo <path> [--start] [--template t] [--labels k=v,...]` registers a project and prints the new project id and path. With `--start`, it also spawns the main-checkout session daemon. The browser's start checkbox defaults off; the flag defaults off too.
- `omp-web rm-project <selector>` deregisters a project. The selector matches a project id, a canonical path, or a repository basename. A refused removal surfaces as a fleet error naming the blocking session daemons.

## Common problems

- **`not a git repository: <path>`** (or the dialog's **not a git repository** notice with **Add repo** disabled): the directory has no `.git` entry. Select the repository root instead.
- **`not a directory: <path>`**: the path no longer resolves to a directory. Re-pick it.
- **`project already registered: <pN>`**: the canonical path is already registered. Use the existing sidebar group. If the group looks wrong, remove it first and register again, understanding that the new project gets a new id.
- **`project <pN> in use by daemons: <ids>`**: session daemons still reference the project. Stop and remove those rows, then retry.
- **Group missing after a fleet restart**: the sidebar only reflects what the state file holds. If a project disappeared, check that the fleet is using the state file you expect (`OMP_FLEET_STATE`, or the data home chosen at first run) and see [Troubleshooting](/operations/troubleshooting/).

## Related

- [Projects, worktrees, session daemons, and sessions](/concepts/projects-worktrees-session-daemons-sessions/)
- [The fleet sidebar](/fleet/sidebar/)
- [Create and adopt worktrees](/fleet/worktrees/)
- [Start, stop, wake, and remove session daemons](/fleet/session-daemon-operations/)
- [Add your first project](/getting-started/add-first-project/)
