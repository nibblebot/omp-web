---
title: Safely delete managed worktrees
description: "Delete a fleet-managed worktree from its roster row: the ownership and dirty-tree guards, the optional branch deletion, and why transcripts survive."
---

Deleting a worktree removes its directory from disk, so omp-web guards the action instead of offering a single destructive click. The guards are ownership, a clean Git tree, and an explicit branch choice. This page describes exactly what is refused, what runs on confirm, and what survives.

Deletion is available on worktree rows in the browser and from the CLI.

This page covers linked worktrees only. A clone workspace deletes through its own verified-deletion gate (quiesce, Git guard, store verification, read-only flip) with no force override; see [Clone workspaces](/fleet/clone-workspaces/).

## What can be deleted

Only a **fleet-managed worktree** can be deleted: a linked worktree whose realpath is under the workspace root (`~/.omp-web/workspaces` by default, or the configured `workspaceDir`; see [Create and adopt worktrees](/fleet/worktrees/) and the [files reference](/reference/files/)).

- An adopted worktree that lives elsewhere on disk is listed on its roster row, but the dialog refuses it as not a managed worktree and leaves it untouched.
- A project's main checkout is never a worktree row, so it has no delete action at all.
- The check is a realpath comparison against the workspace root, not a comparison of path spelling, so symlinked paths cannot smuggle an unmanaged directory past the guard.

## Open the confirmation

On a worktree row, open the actions menu and choose **Delete worktree…**. The item's tooltip says it stops the session daemon and removes the worktree after guard checks. The row immediately asks the fleet for fresh evidence, and the **Delete worktree** dialog opens.

The dialog has three states:

- **Checking evidence.** While the probe runs, the dialog shows `checking worktree state…`.
- **Refused.** An unmanaged path, or a row whose entry has no path at all, shows the refusal reason, and the confirm button stays disabled. Nothing was changed.
- **Eligible.** A managed worktree with a clean Git tree shows what will be removed and the branch option. A managed path that no longer exists on disk is still eligible: deletion then just cleans up the roster entry.

## The dirty-tree guard

Uncommitted work always blocks deletion. When Git reports any added, modified, deleted, or untracked file, the dialog spells out the totals, for example `This worktree has 3 uncommitted changes` followed by per-kind counts, and states that deletion is refused while the worktree is dirty. The confirm button is disabled.

There is no force option anywhere in the browser or the CLI. To make a worktree deletable, commit the work, move it out, or discard it yourself, then reopen the dialog. The dialog re-probes every time it opens, so it never acts on stale evidence.

## Choose whether to delete the branch

When the worktree is eligible and its branch is known, the dialog offers **Also delete branch &lt;branch&gt;** with a hint describing the branch's state:

- `merged and pushed`: the branch tip is already in the main repository's base branch and its commits are on its upstream.
- `merged but unpushed`: the work is in the base branch, but the branch has commits its upstream does not.
- `pushed but unmerged`: the branch is on its upstream but not in the base branch.
- `unmerged`: the branch has commits the base branch does not.

The checkbox starts checked only when the branch is merged and not unpushed. You can always override it before confirming.

Branch deletion is not forced. The fleet runs `git branch -d`, which Git refuses for a branch whose commits are not merged. In that case the worktree is still removed and the branch is left in place, so no commits are silently discarded. Afterward, `git branch --list` in the main checkout shows what remains.

## What runs on confirm

Clicking **Delete worktree** closes the dialog and performs the deletion in a fixed order:

1. Evidence is re-checked on the server. Ownership and cleanliness are verified again, so a refusal at this point leaves the session daemon, the roster row, and the directory exactly as they were.
2. Any browser pipe attached to that session daemon is closed, and the chat column falls back to **No active session** if you were viewing it.
3. The session daemon is stopped and its roster entry is removed.
4. `git worktree remove` runs in the main repository for the managed path.
5. If branch deletion was requested, `git branch -d` runs in the main repository.

Removing a directory that is already gone is treated as success: if the path no longer exists, the roster entry is still cleaned up and nothing else happens. A Git failure during removal is reported as an error and is the one case where the roster entry is already gone while the directory may remain; inspect the directory with `git worktree list` in the main checkout before retrying.

## What survives deletion

- **Session transcripts.** They live under the agent directory, outside every worktree, so the conversation remains resumable by any session daemon on the same checkout. Locations are listed in the [files reference](/reference/files/); the durability model is in [Session persistence](/concepts/session-persistence/).
- **The project registration.** Deleting a worktree removes one checkout, not the project. The project group stays in the sidebar with its main checkout and its other worktrees.
- **The Git history.** Removal deletes the working directory, not the repository; committed work on other branches is unaffected.

If a worktree directory is deleted outside omp-web instead, the fleet detects the missing directory on its next poll, evicts the row, and reports it with a toast such as `Worktree removed on disk: <name> (<path>)`. That path has no guard dialog because omp-web did not perform it.

## Delete worktree versus remove the session daemon

These two actions are easy to confuse because both live in the same menu:

- **Remove daemon** stops the session daemon and drops its roster row (see [Start, stop, wake, and remove session daemons](/fleet/session-daemon-operations/)). The checkout, its files, and its transcripts stay on disk. It works on any row, including main checkouts.
- **Delete worktree** does all of that and then removes the managed directory with Git. It works only on eligible worktree rows.

## CLI equivalent

`omp-web rm-worktree <daemon-id> [--delete-branch]` performs the same deletion through the same server-side guards. Differences from the browser flow:

- The worktree is addressed by its daemon id rather than by clicking a row.
- The evidence dialog is browser-only. The CLI attempts the deletion directly, and a refusal comes back as a fleet error with the guard's message, such as a `409` for a dirty worktree or a `403` for a path outside the workspace root. Nothing is modified on a refusal.
- `--delete-branch` requests the same `git branch -d` behavior; an unmerged branch is still left in place without failing the command.
- No force flag exists. There is no way to make omp-web delete a dirty worktree.
- The route dispatches by workspace kind: pointing the command at a clone workspace id runs the clone verified-deletion gate instead, with no branch flag.

The full signature is in the [CLI reference](/reference/cli/).

## Related

- [Create and adopt worktrees](/fleet/worktrees/)
- [Clone workspaces](/fleet/clone-workspaces/)
- [Start, stop, wake, and remove session daemons](/fleet/session-daemon-operations/)
- [The fleet sidebar](/fleet/sidebar/)
- [Register and remove projects](/fleet/projects/)
- [Files and directories](/reference/files/)
