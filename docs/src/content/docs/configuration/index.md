---
title: Configuration
description: "Where omp-web keeps config, state, workspaces and logs; projects and worktrees; clones and provider profiles."
---

- Default data directory: `~/.omp-web/`
- `config.json`: fleet config, loaded read-only; only the interactive first-run offer and operator edits write it. Keys include `templates` (spawn commands), `workspaceDir`, `bind`, `browserAccessToken` (a sha-256 digest, not plaintext), `browserOrigin`, and `trustedProxies`. `OMP_FLEET_CONFIG` selects a different file. Flags such as `--bind`/`--browser-access-token` and env `OMP_FLEET_BIND`/`OMP_FLEET_BROWSER_TOKEN` override file keys; CLI/env browser tokens are plaintext inputs hashed in memory.
- `fleet-state.json`: roster and registered projects as pretty-printed JSON, written atomically with the file and its directory fsynced, under an exclusive lifetime pidfile lock. Each write keeps the state it replaces as `fleet-state.json.bak`; if the main file is corrupt at startup, the fleet loads the backup, logs that it did, and rewrites the main file on the next change. Writes are coalesced (a burst of status changes shares one write, pending changes flush on shutdown). Defaults beside the selected config; `OMP_FLEET_STATE` selects another path.
- `workspaces/`: default creation destination for local worktrees, created as needed or during accepted first-run setup. `--workspace-dir`, `OMP_FLEET_WORKSPACE_DIR`, or config `workspaceDir` select another directory independently of config and state. Worktrees use `<workspaceDir>/<repo-basename>/<slug(name)>` directly, with no repository marker or hash disambiguation; an existing target is rejected.
- `logs/` beside the state file: durable lineage-file mirrors streamed over enrolled callback pairs when the fleet log store is available. Local spawned sessions are not mirrored; their transcripts stay in their SDK session directory.
- `session-logs/<workspaceId>.log` beside the state file: stdout and stderr of each locally spawned session, appended across restarts. A launch that finds the file above 1 MiB renames it to `<workspaceId>.log.1` (one older generation kept, replaced on the next rotation), and a single run rotates the same way at 1 MiB. `/ctl/sessions/<id>/stderr` and the Debug panel show the last 64 KiB of the file. Deleting or pruning a session removes both generations; the next launch recreates the file.
- `clones/` beside the selected state file: private volumes for new provider-managed clones. Existing clones keep their persisted volume location and provider administration directory even when `workspaceDir` changes; no automatic move occurs.

Interactive first run can choose a data home and write `config.json` there. If you choose a non-default location, set `OMP_FLEET_CONFIG` to that file for subsequent launches. Config, state, and workspace paths can be configured separately; installed code remains in its installation prefix.

`omp-web remove` stops and unregisters the session without deleting files or the Git worktree. Linked worktrees of a registered project offer disk deletion, with clean-tree checks, no force, and removal of their Git-ignored files. Provider-managed clones retain their separate verified-deletion lifecycle.

## Projects and worktrees

A project is any directory, not only a Git repository. A plain directory gets one row for its folder, with the session title and the usual session controls, and no worktrees, clones, branch, or diffstat; `omp-web add-worktree` against it fails with "project is not a git repository". Adding a `.git` later is detected automatically and the project becomes a repository, and removing it reverts the project to a plain directory: its main row stays, shown without Git details, and its linked worktree rows are removed from the sidebar (transcripts kept), a running one once it stops. A directory inside a repository, or a linked worktree, still registers as that repository's main checkout; bare repositories are refused. `git init` in a parent directory of a plain project is not detected.

## Worktree discovery

Worktree discovery is watcher-driven: the fleet watches each project's directory and, for repositories, `.git/worktrees`, so a worktree added from a terminal appears in the sidebar within about a second. When the filesystem gives no events (for example some network mounts), the fleet logs the reason once and polls that project every 60 s instead. Asleep rows are not re-probed: their branch, diffstat, and title stay as they were until the row wakes.

## Fetch into project

Clones cut from the project's local path on a fleet-readable volume (bwrap or host) have a **Fetch into project** row action, also `POST /ctl/clones/<workspaceId>/fetch-into-project`. It fetches the clone's own branch (the branch named after the workspace) from its checkout into the project's main repo: a missing branch is created and an existing one is fast-forwarded, never overwritten. The fleet refuses, and leaves the project untouched, when the project's branch has commits the clone's lacks (not a fast-forward) or is checked out in any worktree of the project (switch that checkout away first). Only committed work travels; uncommitted changes stay in the clone. Remote-source and Kubernetes clones push upstream from inside their runtime and do not offer the action.

## Provider profiles and host clones

Provider-managed clones run on a provider profile from the config file's `providerProfiles` map, offered as the **Run on** choice of the New workspace popover. The profile `provider` is one of `bwrap` (a bubblewrap sandbox on the fleet host), `kubernetes` (a pod with a persistent volume claim), or `host`. A `host` profile has no `executable` and no limits, only an optional `secretRefs`:

```json
{ "providerProfiles": { "host-dev": { "provider": "host" } } }
```

A **host clone** gets the same private volume, checkout, home, callback handoff, verified delete gate, wake resume, Fetch into project and log mirror as a bwrap clone, and its source is the project's local path or a remote URL. The difference is that nothing isolates it: **there is no sandbox**. Its `omp-session` runs as the fleet user, on the fleet host, with that user's filesystem, network and credentials, so the agent in it can read and change anything the fleet user can, including the operator's home directory and credentials. Its environment and `HOME` layout match a bwrap clone's (a fixed allowlist of variables, `HOME` set to the volume's `.home`), but that is layout, not containment. Use a host profile only for repositories and agents you would run directly on this machine; use `bwrap` or `kubernetes` when the agent must be contained. The provider operation protocol and the per-kind capabilities are described in [`docs/provider-protocol.md`](https://github.com/nibblebot/omp-web/blob/main/docs/provider-protocol.md).
