---
title: Data and state management
description: Where omp-web keeps its configuration, registry state, and managed worktrees, where session transcripts and statistics live, and what is safe to back up or delete.
---

omp-web data lives in three separate places: the omp-web data home that the fleet owns, the Oh My Pi agent directories that sessions and statistics use, and the browser storage that holds interface preferences. Clone workspaces add a fourth location outside all three: a provider-managed volume per workspace, holding the clone's checkout and its private agent home. Knowing which is which tells you what a backup needs to include, what is safe to delete, and what survives a worktree cleanup.

omp-web is early-stage software: session transcripts are durable JSONL files, but the surrounding tooling (fleet state, configuration, managed worktrees) is still evolving, so do not treat it as production data storage yet.

## The omp-web data home

The data home is chosen at first run (default `~/.omp-web`) and holds the fleet's own files. The startup banner prints both paths:

```text
fleet state: /home/you/.omp-web/fleet-state.json
fleet config: /home/you/.omp-web/config.json
```

| Path | Contents | Who writes it |
| --- | --- | --- |
| `<data-home>/config.json` | Fleet configuration: spawn templates, the default template, per-project templates, the spawn hook, the managed worktree root, provider profiles for clone workspaces, the bind address, the browser access token (only its sha-256 digest), the browser origin, and trusted proxies. | The first-run offer is the only writer. Hand edits are read on the next start, and unknown keys are tolerated. |
| `<data-home>/fleet-state.json` | The roster and the registered projects, including each entry's directory, last session file, endpoints, and, for spawned and remote entries, its bearer token. Clone entries also carry a fleet-private workspace record (kind, source, pinned revision, profile, desired state, generation, provider handle, deletion state). | The fleet, on every mutation, atomically (a temporary file renamed over the state file). |
| `<data-home>/workspaces/` | Root for fleet-managed worktrees. Created lazily when the first managed worktree is made, never at boot. | The fleet. |
| `<data-home>/logs/` | The fleet log store: a durable mirror of the transcript lineage every managed session daemon streams over the callback pair, laid out as `logs/<workspaceId>/<sessionId>/<relpath>` with a per-session `index.json`. | The fleet, continuously, from the daemons' outbound callback connection. |
| `<data-home>/browser-auth.json` | Live browser sessions for fleet browser auth, keyed by hashed session id. Present only when browser auth is enabled. | The fleet, on login, logout, and token rotation. |

Each path has its own override:

- Config file: `OMP_FLEET_CONFIG`, otherwise `~/.omp-web/config.json`.
- State file: `OMP_FLEET_STATE`, otherwise `fleet-state.json` next to the config file. Because the state path follows the config path, choosing a custom data home at first run moves config, state, and workspaces together.
- Managed worktree root: `--workspace-dir` on `omp-web serve`, then `OMP_FLEET_WORKSPACE_DIR`, then the `workspaceDir` config key, then `~/.omp-web/workspaces`. A leading `~` expands to your home directory.
- The log store and the browser-auth store have no override of their own: they live beside the state file, so they follow the data home with it.

The installed CLI code is separate from all of this. `omp-web update` replaces code in the install prefix (default `~/.omp-web/install/`); it never touches the data home.

### Registry state

`fleet-state.json` is the fleet's memory of what exists:

- Registered projects, keyed by the realpath of the main checkout and assigned monotonic ids such as `p1`.
- Roster entries for local, attached, and remote session daemons, with monotonic ids such as `d3` that are never reused.
- Per-entry facts the fleet needs to operate a row: the bound directory, the template it was spawned from, the last session file, its title, the git branch state, the endpoint, and the bearer token for spawned and remote entries.
- Clone workspace entries additionally carry a fleet-private workspace record: kind, source, pinned revision, profile, desired state, authorized generation, provider handle, and deletion state. It stays in this file and never serializes into roster frames or debug output.

The file is written atomically on every mutation, and ids are never recycled, so a removed project or session daemon does not free its id. Because it stores bearer tokens, treat it as sensitive and keep it readable only by you. The fleet does not store provider credentials here, and it never serializes tokens or endpoints into the frames the browser receives.

One fleet owns one state file. Starting a second fleet against the same state fails loudly, naming the running process and the locked state path, instead of risking two writers. The lock is a pidfile held for the fleet's lifetime and self-heals when the holder is gone. See [Troubleshooting](/operations/troubleshooting/) for recovery.

### Managed worktrees

Managed worktrees live under the workspace root as `<workspace>/<repo>/<worktree>`. They are git worktrees with their files in place, and the fleet owns their lifecycle:

- The root and the repository's directory are created on first use.
- Only worktrees created through the fleet under the workspace root are offered the delete flow. Adopted worktrees elsewhere are never deleted by omp-web.
- Deleting a managed worktree is guarded: the tree must be clean, deletion uses `git worktree remove` without a force option, and the optional branch cleanup uses `git branch -d` only.
- Session transcripts live outside the worktree, so deleting one never deletes history. See [Safely delete managed worktrees](/fleet/delete-worktrees/).

Moving the workspace root does not move existing worktrees. Worktrees under the old root stop being recognized as managed, so the fleet will not offer to delete them; keep the configured root stable, or clean up manually before changing it.

### Clone workspaces

Clone workspaces are not under the data home. Each one runs on a provider-managed volume holding the checkout and a private agent home, and the fleet records only the workspace's metadata in the state file. Provider profiles and secret references live in `config.json`; secret values never do.

The lifecycle is the fleet's job, and it is explicit:

- Stop preserves the checkout and the session logs; only the verified-deletion gate removes the volume.
- Deleting one runs the gate in order: refuse while work is active, quiesce the workspace with a proven stop, guard the clone's Git checkout, verify the fleet store against the volume's own session tree, flip the store copy read-only, then delete provider compute and the volume. A blocked deletion keeps the workspace, its volume, and its logs.
- There is no force override, and uncommitted working-tree state is lost on delete; session transcripts are not a source backup.

See [Clone workspaces](/fleet/clone-workspaces/).

### The fleet log store

`logs/` under the data home is the fleet's own durable copy of session transcripts:

- Every managed session daemon tails its session lineage and streams it to the fleet over an outbound callback pair, so the store keeps up whether the workspace is a local worktree or a clone.
- Layout is `logs/<workspaceId>/<sessionId>/<relpath>` plus a per-session `index.json`, and writes are fsync-before-ack.
- Retention is explicit and manual. Nothing is garbage-collected automatically, verified (read-only) data is never deleted internally, and a workspace that is deleted without passing the verification gate leaves its subtree behind as an orphan that only an explicit purge removes.
- The store is read-only browsable from the Analysis view without waking any compute, and a deleted workspace's sessions remain as view-only history. See [Stored sessions and orphans](/analysis/stored-sessions/).

## Session transcripts

Transcripts are Oh My Pi agent data, not omp-web data, but they are the most important files in the system. Every session is one JSONL file:

- Default location: `~/.omp/agent/sessions/<project>/<file>.jsonl`.
- `PI_CODING_AGENT_DIR` relocates the agent directory, which relocates the sessions tree with it. On Linux, `XDG_DATA_HOME` redirects it when set.
- A session file is pidfile-locked by the session daemon that has it open, so a second session daemon aimed at the same transcript refuses to start rather than risk two writers.

Transcripts are durable while session daemons are disposable: stopping a session daemon, letting it exit on its idle timeout, removing a roster entry, or deleting its worktree all leave the transcript on disk. That is what makes resume possible. A clone workspace writes its transcripts inside its volume, so the fleet log store is the copy that survives the volume; back up the agent sessions tree and the log store to preserve conversations. See [Session persistence](/concepts/session-persistence/) for how resume works.

## Statistics database

The Analysis view reads the Oh My Pi statistics database:

- Default location: `~/.omp/stats.db`. It moves with the Oh My Pi configuration root when that is relocated.
- It is written by the `omp` CLI, not by omp-web. The fleet opens it read-only and never writes to it.
- The Analysis transcripts view can fall back to reading a raw session JSONL for details, and it marks sessions whose files are gone as missing instead of hiding them.
- If the database is stale or missing rows for a transcript, run the sync in the Analysis view. The sync runs `omp stats --summary` against the same database location and refuses to start when another sync is already running. See [Sync the statistics database](/analysis/stats-sync/).

Rows for transcripts that no longer exist on disk cannot be rebuilt, so the database is not a substitute for backing up the transcripts themselves.

## Browser storage

Interface preferences (theme, font size, notifications, sidebar and view state, prompt history) live in the browser's local storage for the site origin. They are not part of the fleet state file, they are not shared between browsers, and clearing site data resets them. [Web interface preferences](/configuration/web-preferences/) lists every key.

## Backups, deletion, and safety

- **To preserve conversations, copy the agent sessions tree and the data home's `logs/` directory.** Transcripts survive session daemon and worktree removal but not file deletion, and a clone workspace's transcripts exist on the fleet side only in the log store.
- **To preserve fleet setup, copy the data home.** That includes registrations, rows, templates, provider profiles, the workspace root, and the log store. Losing it costs the roster and its ids, not repository files or transcripts.
- **omp-web never deletes repository files, transcripts, or the statistics database.** Project removal deregisters; worktree deletion is explicit, guarded, and limited to fleet-managed worktrees; clone deletion is gated on store verification and never has a force override.
- **Deleting a worktree by hand** outside the UI leaves the roster row pointing at a missing directory. Prefer the guarded flow, which removes the row and the directory together.
- **Deleting the state file** starts the fleet with an empty roster and fresh ids. Transcripts, workspaces, and registered projects' files are untouched, but projects must be registered again and clone workspaces are gone from the roster, so their store subtrees become orphans.

## Failure states

- `registry state corrupt at <path>`: the state file is unreadable JSON and the fleet refuses to start rather than discard it. Fix or remove the file; a missing state file is treated as an empty roster.
- A corrupt or unreadable `config.json` silently falls back to defaults, so a typo can look like settings that did not apply. Validate the file, or check the `fleet config:` banner line.
- A state lock held by a dead process clears itself; a lock held by a live fleet means that fleet is running. Do not delete the lock file of a running fleet.
- A session daemon that refuses to start with a session-file lock message means another process holds that transcript; the message names the holder's pid. Resume the session there, or stop that session daemon first.
- `fleet: log store unavailable at <path>: <message>` means the store could not be opened; the fleet boots and runs without it, but clone transcript mirroring is not durable until the path is writable again.
- A clone deletion that refuses reports a typed `delete-pending-retry` error and keeps the workspace, its volume, and its logs. Fix the cause it names, then delete again.
- The statistics database showing zeroed metrics or stale rows means the file is missing or behind; sync it from the Analysis view.

## Related

- [Files and directories](/reference/files/)
- [Environment variables and precedence](/reference/environment/)
- [Configure spawn templates](/configuration/spawn-templates/)
- [Provider profiles](/configuration/provider-profiles/)
- [Web interface preferences](/configuration/web-preferences/)
- [Browser access and sign-in](/operations/browser-auth/)
- [Session persistence](/concepts/session-persistence/)
- [Clone workspaces](/fleet/clone-workspaces/)
- [Stored sessions and orphans](/analysis/stored-sessions/)
- [Safely delete managed worktrees](/fleet/delete-worktrees/)
- [Sync the statistics database](/analysis/stats-sync/)
