---
title: Add your first project
description: Register a Git repository with the omp-web fleet from the browser, then start a session daemon on its main checkout or leave it asleep.
---

Registering a project tells the fleet which Git repository it may run session daemons in. Registration stores metadata only. It does not copy, move, or modify the repository, and it does not create a worktree.

The project roster lives in the fleet sidebar, which is part of fleet mode. Single-session mode (`omp-web session`) has no roster: the browser talks directly to one session daemon.

## Before you start

- omp-web is running and the browser UI is open (see [First run](/getting-started/first-run/)).
- You have a local Git repository: a directory containing a `.git` entry (a directory for a normal checkout, a file for a linked worktree).

## Open the add-project dialog

Two entry points open the same "Add repo" dialog:

- **First run.** While the fleet has no config file, no registered projects, and no session daemons, the sidebar shows a "Welcome to omp-web" panel. Its first step is the "Add your first project" button, and the panel also notes "Sessions appear here once a project exists."
- **Any time.** The "Projects" header at the top of the fleet sidebar has a plus button labeled "Add a project".

## Choose the project directory

The "Project directory" section is a directory browser for the machine that runs omp-web.

- The browser opens in the home directory of the fleet host. Click a subdirectory row to enter it, use the ".." row to go up, click a breadcrumb to jump to an ancestor, or click "refresh" (tooltip "Reload this listing") to reload the current listing.
- Listings contain subdirectories only, sorted by name. A `git` badge marks directories that contain `.git`. Dot-directories are omitted from listings but can still be entered by typing the path.
- Type an absolute path or a `~`-relative path into the input (placeholder "type a path… (~/ ok)") and press Enter to jump there. A listing is capped at 500 entries and shows a truncation note beyond that.
- The footer button selects the directory currently in view. It reads "Select \<name\>", or "Select /" at the filesystem root. After a selection the modal shows "Selected: \<path\>".

A browse error such as `no such directory: <path>`, `unreadable: <path>`, or `not a directory: <path>` appears in the notice area, and the previous listing stays on screen.

## Git validation

Registration requires an existing directory that contains a Git repository.

- When the selected directory was reached through a listing row and has no `.git`, the modal shows "not a git repository" and keeps "Add repo" disabled.
- Manual navigation, breadcrumbs, and up navigation leave the git badge unknown, so the modal lets you submit and the fleet validates the path. Failures report "Failed while creating: not a directory: \<path\>" or "Failed while creating: not a git repository: \<path\>".
- Paths are canonicalized before validation, including `~` expansion and symlink resolution, so one repository reached through a symlink or a different spelling is still one project.

## Advanced fields (optional)

Open "Advanced" to override the defaults:

- **template**: the spawn template used when a session daemon starts on this checkout. Defaults to `local`. Available names load from the fleet, and a load failure appears inline.
- **labels**: comma-separated `k=v` pairs, placeholder `tag=api, env=prod`. Every label needs a nonempty key and an `=`; malformed labels are rejected when you submit.

The chosen template and labels are stored on the project's main-checkout row and reused whenever a session daemon starts from it.

## Start a session now (optional)

"Start a session now" is off by default.

- **Off:** choose "Add repo". The modal closes after submission. When registration succeeds, the new row appears in the sidebar and no session daemon runs yet. Start one whenever you are ready (see [Start your first session](/getting-started/start-first-session/)).
- **On:** the fleet registers the project first, then starts a session daemon on the main checkout with the selected template and labels. The modal tracks "registering project", then "spawning daemon", then "attaching session", with the notes "registering the project…", "starting the daemon…", and "attaching to the session…". When the session daemon is ready the browser attaches and the modal closes. If the checkout has transcripts on disk, the "New session or resume" picker opens; otherwise a fresh session starts.

## Expected result

- The sidebar gains a collapsible group named after the repository directory. The group header tooltip carries the full path.
- The group lists the main checkout first: a row for the repository itself, which is also its default workspace. Worktree rows and a "+ Add worktree" action appear below it.
- With "Start a session now" off, that row is asleep. Clicking the row wakes the session daemon and attaches; nothing runs until then.
- With it on, the row progresses from spawning to ready, and then the browser attaches.
- The group header offers its start icon, labeled "Start a session in \<project\>", only when a project has no main-checkout row at all. Adding a project normally creates that row, so you start sessions by clicking the row instead.

## Where this is stored

- The project and its main-checkout row persist in the fleet state file under the data home chosen at first run (`~/.omp-web/fleet-state.json` by default). The `OMP_FLEET_STATE` environment variable can point elsewhere.
- Project IDs are monotonic `pN` values that are never reused. The project name is the basename of the canonical path, and projects keep their insertion order.
- Nothing under the repository changes, and no managed worktree is created. Removing the project later only deregisters it; it never touches the files on disk.

## Common errors

- **"not a git repository"** with "Add repo" disabled: the selected directory has no `.git` entry. Select the repository root instead.
- **`not a directory: <path>` / `not a git repository: <path>`**: the fleet's validation failed after a manual selection. With "Start a session now" off, the modal has already closed and the error appears in the status bar. With it on, the modal reports the failed stage and offers a "Close" button. Correct the path and reopen the dialog.
- **`project already registered: <pN>`**: the canonical path already belongs to a registered project. Use the existing sidebar group. Duplicate registration is deduplicated by canonical path rather than creating a second project.
- **`project <pN> registered, spawn failed: <reason>`**: the project was registered but the immediate session start failed. Registration is kept, so retry from the project's group in the sidebar.

## Next steps

Continue to [Start your first session](/getting-started/start-first-session/) to wake the main-checkout row and send your first prompt. For a tour of the surrounding UI, see [Interface tour](/getting-started/interface-tour/).
