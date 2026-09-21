---
title: Manage projects and worktrees
description: "Register and deregister Git projects, create or adopt linked worktrees, and delete managed worktrees from the terminal with the same guards the browser UI applies."
---

The fleet does not scan for projects. A repository joins it only when you register it, and a checkout gets a roster row only when you create or adopt a worktree, create a clone workspace, or spawn a session daemon on a directory directly. These commands perform the same registration work as the fleet sidebar and enforce the same safety rules: registration never touches repository files, only fleet-managed worktrees can be deleted, and deletion refuses a dirty checkout.

The fleet must be running and reachable on the control port; see [CLI overview](/cli/overview/) for that connection. For the underlying model, see [Projects, worktrees, session daemons, and sessions](/concepts/projects-worktrees-session-daemons-sessions/).

## List discovered worktrees

```sh
omp-web projects
```

The command reports the linked worktrees Git knows about for the registered projects that no roster row uses yet. Each row is a candidate for adoption with `omp-web add-worktree --existing`.

| Column | Meaning |
| --- | --- |
| `name` | The linked worktree's directory name |
| `path` | The linked worktree's absolute path |
| `branch` | The branch the worktree has checked out, when the fleet could probe it |
| `worktreeOf` | The main checkout's directory name, which is also the project name |

Registered projects themselves are not part of this table; the command answers "what can be adopted", not "what is registered". A roster row names its project in the `project` column of `omp-web sessions`, and `add-repo` prints the project id when it registers one. A project whose checkout stopped being a Git repository is skipped silently, and an unregistered worktree row is the same set the browser's add-worktree dialog offers as existing worktrees.

## Register a project

```sh
omp-web add-repo ~/code/app
omp-web add-repo ~/code/app --start
omp-web add-repo ~/code/app --start --template review --labels role=review,tier=2
```

- The path must be an existing directory inside a Git repository. The fleet stores the realpath, so a symlinked or relative spelling of the same directory resolves to one project. Validating a path that is missing, not a directory, or not a Git repository exits 1 with the validation message.
- Registering the same repository again exits 1 and names the existing project id. The realpath is the dedup key, so there is no second registration path.
- Registration also creates the project's default workspace row: a roster entry for the main checkout. Without `--start` that entry is registered asleep, and the command reports the project and stops there. With `--start` the fleet spawns the session daemon immediately and reports the new session daemon id as well.
- Add `--template <name>` to choose a spawn template for that first start. An unknown template name fails the spawn stage; see [Configure spawn templates](/configuration/spawn-templates/).
- `--labels k=v,...` attaches labels in one comma-separated flag. Labels are what `label:k=v` selectors match later, so they are worth setting for session daemons you plan to prompt in bulk. Other commands take repeated `--label` flags instead; see [Select multiple session daemons](/cli/selectors/).
- A spawn failure during `--start` exits 1 after the project itself is registered. The project stays in the registry, and you can start it later with `omp-web spawn` or from the browser.

## Deregister a project

```sh
omp-web rm-project p1
omp-web rm-project ~/code/app
omp-web rm-project app
```

The selector resolves client-side against the registered set, in this order: an exact project id such as `p1`, an exact registered path, a project name, or any path whose realpath matches a registered path. A selector that matches nothing exits 1 and echoes the selector.

Deregistration only removes the registration.

- Repository files, checkouts, and session transcripts are never touched.
- The project's never-started default workspace row (asleep, no session ever recorded) is dropped with it.
- Removal is refused while any other roster entry still references the project, and the message lists the blocking session daemon ids. Remove those with `omp-web remove <selector>`, deleting managed worktrees where appropriate, and retry.

This matches the browser behavior described in [Remove projects](/fleet/projects/).

## Create or adopt linked worktrees

Two forms register a linked worktree for a project:

```sh
omp-web add-worktree app feature-x
omp-web add-worktree app feature-x --base main
omp-web add-worktree app hotfix --branch release/2.1 --no-start
omp-web add-worktree app --existing ~/code/app-hotfix
```

`<project>` accepts the same id, path, or name selector forms as `rm-project`.

Create-new form:

- The worktree goes under the workspace root at `<workspaceDir>/<repo-basename>/<slug>`, where the slug lowercases the name and collapses runs of non-alphanumeric characters into single hyphens. The workspace root is created on first use.
- Without `--branch`, the fleet creates a branch named after the slug. `--base <ref>` chooses the base; without it the fleet uses the remote default branch when it is known, otherwise the main checkout's current branch, otherwise `HEAD`. The fleet never fetches, so a stale remote is used as-is.
- With `--branch <existing>`, the fleet attaches an existing local branch instead of creating one. A branch that is already checked out in another worktree is refused, as is a branch that does not exist.
- The session daemon is spawned by default. `--no-start` registers the row without a process; it appears asleep in the roster and can be woken later. See [Understand roster status](/fleet/roster-status/).
- The command reports whether the worktree was created or registered, the session daemon id, and either the current status or that it was not started.

Adopt-existing form:

- `--existing <path>` registers a linked worktree that Git already knows about for the project and that no roster row uses yet. A path that is not a linked worktree of that project, or that is already registered, exits 1 with the reason.
- Adoption takes the same `--no-start` flag and defaults to starting.

A worktree that was created but whose spawn failed stays on disk as an unregistered linked worktree, so it appears in `omp-web projects` and can be adopted again. See [Create and adopt worktrees](/fleet/worktrees/) for the dialog equivalents.

## Create a clone workspace

A clone workspace is the second way to get a checkout of a project, and it is not a Git worktree: it is an independent clone on a provider-run volume, with its own object store, its own agent directory, and its own lifecycle. Use it when the work should run somewhere other than this machine.

```sh
omp-web add-clone app sandbox-1 --profile bwrap-dev
omp-web add-clone app sandbox-2 --profile k8s-ci --remote ssh://git@host/srv/app --revision 4f9c1ab --no-start
```

- `--profile <id>` is required and must name a loaded provider profile. `omp-web profiles` lists them, and a fleet with none configured has no clone route to call.
- The source is at most one of `--local <path>` (a path on the fleet host) and `--remote <url>` (a reachable Git URL). With neither, the server uses the registered project's local path. A `kubernetes` profile cannot read a fleet-host path at all, so it refuses a local source and needs `--remote`.
- `--revision <rev>` pins the initial commit and `--branch <b>` selects the branch. The pin is resolved once and reused by retries, so a later fetch cannot change what the volume was prepared from.
- The session daemon starts by default, exactly as with `add-worktree`; `--no-start` registers the row parked and starts nothing.
- The command reports whether the clone was created, the session daemon id, and either the status with its lifecycle stage or that it was not started.

Validate the profile on the host that will run it before you create the first workspace:

```sh
omp-web preflight --profile bwrap-dev
```

It probes the provider executable, the callback reachability, the durable state directories, the declared tools, the deny roots, and the secret references, prints one line per check, and exits 1 if any check fails. See [Provider profiles](/configuration/provider-profiles/) and [Sandboxed session runtime](/advanced/sandbox-runtimes/).

## Delete a managed worktree

```sh
omp-web rm-worktree d4
omp-web rm-worktree d4 --delete-branch
```

This command takes one session daemon id, taken from `omp-web sessions`, and acts on exactly that row; it does not accept selector forms. It stops the row's process, drops it from the roster, and removes the worktree directory with Git.

The same verb handles a clone workspace row, dispatching on the entry's kind. For a clone it runs the verify-at-deletion gate before anything is removed: writers are stopped, the Git guard runs against the clone's `.checkout/`, the fleet store is checked for completeness against the volume's own session tree, and only then does the store subtree flip read-only and the provider delete the compute and the volume. A blocked deletion keeps the workspace, its volume, and its logs, and reports the reason, so there is nothing to undo. The output names how many sessions were verified: `removed clone workspace daemon <daemonId> (verified <n> sessions)`. See [Clone workspaces](/fleet/clone-workspaces/).

Guards run before anything is mutated, so a refusal leaves the row, the process, and the directory untouched:

- Only worktrees under the fleet workspace root are managed and deletable. A worktree adopted from elsewhere is never deleted. There is no force option.
- A worktree with uncommitted changes is refused.
- `--delete-branch` additionally attempts to delete the branch with `git branch -d`, which Git refuses for a branch that is not merged. In that case the worktree is still removed and the branch is left in place; the command's output still names the branch the worktree was on, because the fleet reports the branch it found, not whether Git accepted the deletion.
- Session transcripts live outside the worktree, under the agent directory, so deleting a worktree never deletes conversation history. See [Session persistence](/concepts/session-persistence/).

The browser flow with its confirmation and evidence lines is described in [Safely delete managed worktrees](/fleet/delete-worktrees/).

## Failure behavior

| Message | Situation |
| --- | --- |
| `not a directory: <path>` | `add-repo` or an adopt path that does not exist |
| `not a git repository: <path>` | `add-repo` on a directory that is not a Git checkout |
| `project already registered: pN` | The realpath is already registered |
| `no registered project matches selector: <selector>` | `rm-project` or `add-worktree` project selector that resolves to nothing |
| `project pN in use by daemons: d1, d2` | `rm-project` while roster entries still reference the project |
| `worktree target already exists: <path>` | A directory already occupies the managed path |
| `branch is already checked out elsewhere: <branch>` | `--branch` names a branch Git holds in another worktree |
| `unknown branch: <branch>` | `--branch` names a branch that does not exist |
| `not a linked worktree of <project>: <path>` | `--existing` on a path that is not a worktree of that project |
| `worktree already registered: <path>` | `--existing` on a path already mapped to a roster row |
| `not a managed worktree (path outside workspaceDir)` | `rm-worktree` on a worktree the fleet does not own |
| `worktree has uncommitted changes` | `rm-worktree` on a dirty worktree |
| A clone deletion that reports a pending retry | The verify-at-deletion gate refused: the workspace, volume, and logs are retained so you can fix the cause and retry |

Control-plane failures exit 1, so a script can branch on the exit status; the message on stderr names the cause.

## Related

- [CLI overview](/cli/overview/)
- [Operate session daemons](/cli/session-daemon-operations/)
- [Select multiple session daemons](/cli/selectors/)
- [Projects, worktrees, session daemons, and sessions](/concepts/projects-worktrees-session-daemons-sessions/)
- [Create and adopt worktrees](/fleet/worktrees/)
- [Safely delete managed worktrees](/fleet/delete-worktrees/)
- [Clone workspaces](/fleet/clone-workspaces/)
- [Provider profiles](/configuration/provider-profiles/)
- [Sandboxed session runtime](/advanced/sandbox-runtimes/)
- [CLI commands and flags](/reference/cli/)
