---
title: Files and directories
description: Canonical locations for the installed omp-web code, the data home, fleet configuration and state, managed worktrees, session transcripts and locks, the statistics database, and browser-local settings.
---

omp-web touches several separate trees with different owners: the installer and updater own the installed code, the fleet owns a data home, session daemons write session transcripts through the Oh My Pi agent runtime, the Analysis views read a statistics database that the `omp` CLI maintains, and the browser holds interface preferences in `localStorage`. This page is the canonical list of those locations: exact defaults, who writes them, and what deleting them costs.

Only a few locations are configurable. Each section states its precedence chain, and the [environment reference](/reference/environment/) owns the full variable list. Commands here use the installed `omp-web` command.

## Scope

| Location group | Applies to |
| --- | --- |
| Installed code and the `omp-web` command link | every install |
| Data home, fleet config, fleet state and lock, managed worktrees | the fleet |
| Fleet log store | the fleet, for every session daemon it manages |
| Clone workspace volumes | the fleet, for clone workspaces |
| Session transcripts, transcript locks, session artifacts | the fleet and the session daemons it drives |
| Statistics database and the sessions tree the Analysis views read | the fleet-served Analysis views |
| Browser-local preferences | the browser, stored per origin |
| Build and development outputs | source checkouts |

## Locations at a glance

| What | Default location | Written by | Configurable |
| --- | --- | --- | --- |
| `omp-web` command | `$BUN_INSTALL/bin/omp-web` (default `~/.bun/bin/omp-web`) | the installer | at install time |
| Installed bundle | `~/.omp-web/install/node_modules/omp-web/dist-bundle/cli.js` | the installer and `omp-web update` | at install time |
| Data home | `~/.omp-web` | the first-run offer | the first-run answer |
| Fleet config | `~/.omp-web/config.json` | the first-run offer (only writer) | `OMP_FLEET_CONFIG` |
| Fleet state | `<config directory>/fleet-state.json` | the fleet | `OMP_FLEET_STATE` |
| Fleet state lock | `<state file>.lock` | the fleet | follows the state file |
| Fleet log store | `<state file directory>/logs/` | the fleet, from the lineage streams daemons send | follows the state file |
| Managed worktree root | `~/.omp-web/workspaces` | worktree actions | `--workspace-dir`, `OMP_FLEET_WORKSPACE_DIR`, the `workspaceDir` key |
| Clone workspace volume | `<workspace root>/<daemonId>/` | the clone lifecycle | the same root as managed worktrees |
| Clone provider state | `<workspace root>/.provider-state/<daemonId>/` | the clone provider | the same root as managed worktrees |
| Session transcripts | `~/.omp/agent/sessions/<project>/<session>.jsonl` | the agent runtime inside a session daemon | `PI_CODING_AGENT_DIR`, `XDG_DATA_HOME` |
| Transcript lock | `<transcript>.lock` | the session daemon that owns the transcript | follows the transcript |
| Statistics database | `~/.omp/stats.db` | the `omp` CLI | `PI_CONFIG_DIR` |
| Browser preferences | `localStorage` for the site origin | the browser UI | none, per browser profile |

## Installed code

The installer and the updater own one directory tree, separate from all fleet data. It holds the bundled CLI together with the exact dependency versions it was released with.

| Path | Contents |
| --- | --- |
| `<prefix>/install/` (default `~/.omp-web/install`) | the pinned install directory; `omp-web update` refuses to run anywhere else |
| `<prefix>/install/package.json` | a private anchor project, so Bun never attaches the install to an ancestor project directory |
| `<prefix>/install/node_modules/omp-web/` | the released `omp-web` package with its own pinned `@oh-my-pi/*` dependencies |
| `<prefix>/install/node_modules/omp-web/dist-bundle/cli.js` | the bundled entrypoint; the UI assets are copied next to it inside `dist-bundle/` |
| `<prefix>/install/patches/` | legacy only: releases up to 0.2.0 copied `patches/@oh-my-pi%2Fpi-agent-core@18.2.6.patch` here and declared it in `<prefix>/install/package.json`. No patch files ship with a current install, and neither the installer nor `omp-web update` removes leftovers; see [Updates](/operations/updates/) for the manual cleanup |
| `$BUN_INSTALL/bin/omp-web` (default `~/.bun/bin/omp-web`) | the symlink to that entrypoint, the command on your `PATH` |

- The one-line installer downloads `omp-web-<version>.tgz` and `release-manifest.json`, verifies the tarball SHA-256 against the manifest, installs into the pinned directory, and links the command. An existing pinned install is upgraded in place.
- Current releases ship no dependency patches: the tarball carries `dist-bundle/` only, and a fresh prefix installs the pinned `@oh-my-pi/*` packages exactly as published upstream. An install made by a release up to 0.2.0 keeps its `patchedDependencies` entry for `@oh-my-pi/pi-agent-core@18.2.6` and the copied patch file until they are removed by hand; [Updates](/operations/updates/) has the steps.
- `omp-web update` verifies the release tarball the same way, stages it in the system temp directory, reinstalls it in the same pinned directory, and removes the temporary file. It does not move an install and does not touch the data home.
- A source checkout installs the same layout with `bun run install:omp-web [tarball] [--prefix <dir>] [--bin-dir <dir>]`. The defaults match the release installer: prefix `~/.omp-web`, bin directory `$BUN_INSTALL/bin` (`~/.bun/bin`).
- The prefix and the bin directory are decided at install time. Choosing a different data home never moves the code, and `~/.omp-web/install/` belongs to the installer even when the data home is also `~/.omp-web`.

Error behavior: the installer stops before installing anything when the SHA-256 does not match the manifest, or when neither `sha256sum` nor `shasum` is available. `omp-web update` refuses to reinstall when the running bundle is not inside a pinned install directory and exits 1 with a reinstall hint.

```sh
omp-web --version
```

See [Installation](/getting-started/installation/) for the full install flow and [Updates](/operations/updates/) for the update flow.

## Data home

The data home is chosen on the first interactive run and holds everything the fleet owns. Do not confuse it with the Oh My Pi agent directory (default `~/.omp/agent`), which holds session transcripts and agent settings instead.

| Path | Contents |
| --- | --- |
| `<data-home>/config.json` | fleet configuration: the `workspaceDir` key the offer records, plus `templates`, `defaultTemplate`, `projectTemplates`, `spawnHook`, `bind`, `browserAccessToken`, `browserOrigin`, `trustedProxies`, and `providerProfiles` when you add them |
| `<data-home>/fleet-state.json` | the roster, the registered projects, the fleet-private clone workspace records, and any store-orphan markers; per-entry facts include the bound directory, last session file, endpoint, and bearer token |
| `<data-home>/fleet-state.json.lock` | the fleet's exclusive pidfile lock |
| `<data-home>/browser-auth.json` | browser sign-in sessions, written next to the state file and only when browser auth is configured |
| `<data-home>/logs/` | the fleet log store: a durable copy of the session lineage each managed daemon streams |
| `<data-home>/workspaces/` | managed worktrees and clone workspace volumes |
| `<data-home>/dev-fleets/<slug>-<hash8>/` | per-worktree state and lock used by the development runners (source checkouts only) |

Resolution:

- Config file: the path the first-run offer chooses, or `OMP_FLEET_CONFIG` when set, otherwise `~/.omp-web/config.json`. A leading `~` expands to your home directory, and an empty variable counts as unset.
- State file: `OMP_FLEET_STATE` when set, otherwise `fleet-state.json` next to the resolved config file. The state moves with the config, so the data home choice keeps config, state, and workspaces together.
- Log store: `logs/` next to the resolved state file. It is not configurable separately, so moving the state file moves the store with it.
- Workspace root: `--workspace-dir` on `omp-web serve`, then `OMP_FLEET_WORKSPACE_DIR`, then the `workspaceDir` key in the config file, then `~/.omp-web/workspaces`.

Accepting the offer creates the data home and the workspace root immediately and writes the config there. Declining it, or running non-interactively, serves with defaults and writes nothing; the workspace root is then created lazily on the first managed worktree. Later launches resolve the config path again, so to keep using a data home other than the default, point `OMP_FLEET_CONFIG` at its `config.json`.

Error behavior:

- No config file: the fleet starts with defaults and the banner prints `fleet config: (defaults)`. An interactive launch offers setup instead.
- Unreadable or malformed config: the fleet falls back to defaults for the whole file rather than failing, and unknown keys are tolerated. A key with the wrong type also reads as its default.
- No state file: the fleet starts with an empty roster and fresh ids.
- Corrupt state file: the fleet refuses to start with `registry state corrupt at <path>` rather than discard it.

See [First run](/getting-started/first-run/) for the prompt and [Data and state management](/configuration/data-and-state/) for operational consequences.

### Fleet state and lock

`fleet-state.json` is the fleet's memory of what exists. It stores the registered projects (realpath-keyed, with monotonic `pN` ids), the roster entries (monotonic `dN` ids that are never reused), the next-id counters, and the per-entry facts the fleet needs to operate a row, including the bearer token of spawned and remote session daemons. Treat it as a credential file and keep the data home private.

- Every mutation is written atomically: a sibling `<state file>.tmp` file is written first, then renamed over the state file, so an interrupted write cannot leave a half-written roster.
- One fleet owns one state file. The lock `<state file>.lock` is created exclusively and holds the holder's `pid`, `name`, and `startedAt`; it is held for the fleet's lifetime and released on shutdown.
- A second fleet over the same state file refuses to start, exits with code 77, and prints `fleet already running (pid <pid>)` together with the lock path.
- A clean shutdown releases and removes the lock. A stale lock (dead pid, unreadable content, or garbage) is broken and retried automatically on the next start. Never delete a lock held by a live process.
- Tokens and endpoints are never serialized into the frames the browser receives, but they are on disk in this file.

A roster entry for a clone workspace also carries a fleet-private workspace record, which is never sent to a browser or to a session daemon. It holds the workspace kind (`worktree`, `clone`, or `direct`), the owning project id, the clone source (a local path or a remote URL), the pinned revision, the derived branch, the provider profile id, the desired state (`running` or `stopped`), the authorized credential generation, the provider's own opaque handle, the in-flight deletion state, and the enrollment record. The enrollment record stores the SHA-256 hex digest of the workspace credential, never the credential itself, so an entry can be authenticated but not impersonated from this file. The browser sees only the projected subset: workspace kind, desired state, profile id, and the lifecycle stage.

A workspace whose store subtree survived a deletion without passing the verification gate leaves a store-orphan marker in this file, with the timestamp, the reason, and the provenance (source and pinned revision) that is otherwise lost when the clone identity goes away. See [Stored sessions](/analysis/stored-sessions/) for what can still be read from it.

The projection is deliberate, not incidental: the roster frames the edge sends to browsers drop the bearer token, the endpoint URL, the template name, the provider handle, the deletion state, the enrollment record, and the clone source. If you need to see what is really recorded, read the state file on disk.

## Managed worktrees and markers

Managed worktrees live under the workspace root, one directory per repository basename, with the slugified worktree name underneath:

```text
<workspaceDir>/<repo-basename>/<slug(name)>
```

- The name slug is lowercase, runs of non-alphanumeric characters collapse to a single `-`, and leading and trailing dashes are trimmed. A name that slugifies to nothing becomes `worktree`.
- Ownership is recorded in the marker file `<workspaceDir>/<repo-basename>/.omp-web-repo`, which contains the owning repository's realpath. The worktree creation flow writes it; the path helpers only read it.
- When a directory with the same basename already belongs to a different repository, the basename gains a `-<hash>` suffix derived from the repository realpath, keeping `<workspaceDir>/<repo-basename>` unique per repository.
- The workspace root and the repository directory are created lazily on the first worktree creation, never at fleet boot. The first-run offer is the exception: it creates the root it records in the config.
- Deleting a managed worktree requires ownership (the realpath is under the workspace root) and a clean tree. There is no force option, the removal uses `git worktree remove`, and the optional branch cleanup uses `git branch -d` only. Nothing outside the workspace root is ever removed.
- Session transcripts live under the agent directory, never inside a worktree, so deleting a worktree never deletes history.
- Removing the marker loses the ownership record. After that, a worktree for a different repository with the same basename maps to the same directory, and creation is refused while that directory exists.
- The marker belongs to worktrees only. A clone workspace volume is not a Git worktree registered under this scheme, and it carries no `.omp-web-repo` file: the fleet state record is what ties that volume to its project.

See [Create and adopt worktrees](/fleet/worktrees/) and [Safely delete managed worktrees](/fleet/delete-worktrees/).

## Clone workspace volumes

A clone workspace is an independent checkout that a provider runs for the fleet, and its whole state lives on one volume rooted at `<workspaceDir>/<daemonId>`, where `<daemonId>` is the roster id, for example `d7`.

```text
<workspaceDir>/<daemonId>/
  .checkout/                 the working clone
  .home/                     the sandbox's private home
    agent/                   the agent directory inside the sandbox
      sessions/              transcripts written by sessions here
      config.yml             seeded agent settings
      models.yml             seeded provider definitions
  .omp-workspace-init.json   the prepared-volume marker
```

| Path | Contents |
| --- | --- |
| `.checkout/` | The working clone. It is a real clone with an independent object store: no hardlinks and no alternates, and the fleet verifies that independence before it finalizes the volume. Only committed history is copied; uncommitted files in the source are never transferred. |
| `.omp-workspace-init.json` | The prepared-volume marker, described below. |
| `.home/` | The private home the sandbox sees as `HOME`. A fleet-local sandbox gets exactly two writable mounts, this home and the checkout; everything else it can see is read-only. |
| `.home/agent/` | The agent directory inside the sandbox (`PI_CODING_AGENT_DIR` points here), so agent settings and sessions stay on the volume. |
| `.home/agent/sessions/` | Transcripts for sessions that ran in this workspace, nested exactly as in a normal agent directory. |
| `.home/agent/config.yml` | A copy of your global agent config, seeded from allowlisted agent-behavior keys only. An existing file is never overwritten. |
| `.home/agent/models.yml` | Provider definitions seeded from a `models.yml` beside your global config. Only environment references travel, never literal secrets, and an existing file is never overwritten. |

The marker file is written twice, which is what makes a retry safe. First the pin, holding the workspace id, the source, the resolved commit, and the branch, is written before the clone starts, so a retry reuses the pinned commit instead of resolving a new one. Then the verified form adds the initialization time and the preparation version, and that write happens last, after the checkout is verified against the pin. A pin without those two fields means "prepared, not verified". An unparseable marker beside an existing `.checkout/` is a conflict the fleet refuses to resolve on its own.

Provider supervision state lives beside the volumes rather than inside one, at `<workspaceDir>/.provider-state/<daemonId>/`: the enrollment handoff file, provider process records, the supervisor spec, its error log, and a lock. Treat that directory as fleet-private.

Honest limits: transcripts record the conversation, not the working tree, so uncommitted work in a clone is not recoverable from them, and the verification gate is what decides whether stored history may be deleted. See [Clone workspaces](/fleet/clone-workspaces/) and [Sandboxed session runtime](/advanced/sandbox-runtimes/).

## Fleet log store

The fleet mirrors the session lineage that managed session daemons stream, so a session's history outlives the compute that produced it. The store root is `logs/` next to the state file:

```text
<state dir>/logs/<workspaceId>/<sessionId>/<relpath>
```

- `<workspaceId>` is the roster id of the session daemon that owns the session, for example `d7`.
- `<sessionId>` is the slash-free session identifier, the same key the fleet uses to resume a session.
- `<relpath>` is the file's path relative to the sessions root, so the main transcript is `<sessionId>.jsonl`, or `<project>/<sessionId>.jsonl` when the runtime nests it there, and artifacts live under the transcript's stem directory.

Each session directory carries an `index.json` sidecar: a version, the workspace and session ids, and one entry per stored file recording its generation, the acknowledged durable offset, and whether the stream reached its end. Because bytes are acknowledged as they arrive, a partial stream is detectable rather than invisible, and a gap is reported rather than filled in. `index.json` and `readonly.json` are reserved names inside the store.

A workspace that passes its deletion gate gets a `readonly.json` marker at `<state dir>/logs/<workspaceId>/readonly.json`, holding the version, the workspace id, and the time it was marked. Ingest into a read-only workspace is refused, and the marker is re-read from disk, so the flip survives a restart.

Retention is explicit and manual. There is no garbage collection and no timer: `POST /ctl/logs/purge {workspaceId}` is the only removal path, and it is refused for a live workspace whose store is still writable. `GET /ctl/logs/orphans` lists the store subtrees whose workspace is gone, with the session count, the byte size, whether the subtree is read-only, and whether the registry still holds a matching orphan marker. A session deleted inside the workspace purges that session's copy here, so the workspace wins.

The read side is the stored-session surface (`/ctl/stored/...`), which reads the store only: browsing stored history never wakes compute, and a deleted workspace's sessions stay viewable. See [Stored sessions](/analysis/stored-sessions/).

## Session transcripts and locks

Transcripts are Oh My Pi agent data, written by the agent runtime inside a session daemon, whether the fleet spawned it or you started it by hand.

| Location | Resolution |
| --- | --- |
| Sessions directory | `$PI_CODING_AGENT_DIR/sessions` when the variable is set, else `$XDG_DATA_HOME/omp/agent/sessions` when `XDG_DATA_HOME` is set, else `<config root>/agent/sessions`, which defaults to `~/.omp/agent/sessions` |
| Transcript | `<sessions directory>/<project directory>/<session file>.jsonl` |
| Subagent and advisor transcripts | `<sessions directory>/<project directory>/<session file without .jsonl>/`, nested the same way for deeper subagents |
| Transcript lock | `<transcript>.lock` |

- The project directory name encodes the session working directory: relative to your home directory it is `-<path with separators as dashes>`, under the system temp root it is `-tmp-<path>`, and outside both it is `--<absolute path with separators as dashes>--`.
- A transcript opens with a fixed title slot line and a session header; message entries follow. Persistence is lazy, so a fresh session that has produced no assistant output may have no file on disk yet.
- The session daemon locks every transcript it opens, including a `--resume` target, for its whole lifetime. A second session daemon aimed at the same transcript exits 1 with `omp-session: session file <file> is locked by another omp-session (pid <pid>)`. A clean shutdown removes the lock file, and a lock left behind by a dead process is broken automatically on the next start.
- Session daemons spawned by the fleet inherit the fleet process environment, so they all resolve the same sessions directory unless the fleet itself is started with a different environment or a custom template points a session daemon elsewhere.
- Deleting a transcript permanently deletes that conversation. The roster's recent-sessions dropdown and the transcripts browser read the sessions tree from disk, so a deleted transcript stops being resumable.

```sh
ls ~/.omp/agent/sessions/
```

See [Session persistence](/concepts/session-persistence/) for what survives what, and [Browse historical transcripts](/analysis/transcripts/) for the read-only view.

### Agent directory files that omp-web reads

The agent directory (default `~/.omp/agent`) belongs to the Oh My Pi agent, not to the fleet. omp-web reads and writes these through the SDK:

- `sessions/` holds the transcripts listed above.
- `config.yml` holds agent settings. The Settings sheet writes changes through the SDK, and settings for a session that has not resolved a model yet apply to new sessions.
- `<project>/.omp/config.yml` holds project-scoped agent settings, written when you save model roles with project storage selected.
- Provider authentication is resolved from the same agent directory; manage it with the `omp` CLI rather than editing files by hand.
- The first-run check resolves the `omp` binary from `PATH`, then from `~/.bun/bin/omp`.

Changing the agent directory after sessions exist points future work at a different history, because both the session daemon and the Analysis views resolve transcripts from it.

## Statistics database

The Analysis views read the Oh My Pi statistics database. omp-web opens it read-only and never writes to it; the `omp` CLI fills it.

| Path | Notes |
| --- | --- |
| `$PI_CONFIG_DIR/stats.db`, default `~/.omp/stats.db` | the database; the reader treats `PI_CONFIG_DIR` as a literal path |
| `stats.db-wal`, `stats.db-shm` | SQLite write-ahead sidecars created by the `omp` CLI |
| `$PI_CODING_AGENT_DIR/sessions` (see the transcript chain above) | the sessions tree the reader enriches from |

- The handle is opened read-only with `query_only` enforced. If the sidecars are missing after a crash, the reader copies the database and its sidecars into a temporary directory under the system temp directory and reads the copy; the copy is removed when the handle is reprobed or the fleet closes.
- The sync action runs the `omp` statistics summary command with an environment derived from the resolved database location, so the child writes the same file the viewer reads. A database outside your home directory cannot be addressed by the `omp` CLI and the sync reports that specific failure.
- The database is a derived index over transcripts. Deleting it or leaving it stale costs analytics only, never conversations. Run a sync to rebuild it.

See [Sync the statistics database](/analysis/stats-sync/) for the sync workflow and [Session analytics](/analysis/analytics/) for the views.

## Session artifacts

The composer and the agent runtime create a few files during normal use:

| Artifact | Location | Created by |
| --- | --- | --- |
| Exported session HTML | `omp-session-<session file basename>.html` in the session daemon's process working directory | the `/export` command |
| LLM request dump | `omp-llm-request-<id>.json` in the system temp directory | the `/dump` command |
| Transcript text download | your browser's download location, named `transcript.txt` | the `/dump` command |
| Project-scoped agent settings | `<project>/.omp/config.yml` | the omp stack when you save project-scoped roles |

For a session daemon spawned by the fleet, the process working directory is inherited from the fleet process; for `omp-web session`, it is the directory you started the command from. The session daemon's download route serves only files under the system temp directory, the bound directory, the session daemon's process working directory, or the live session file's directory, and the fleet does not proxy it, so the browser never fetches these files. The export and dump notices name the path on the session daemon's host, where you retrieve the file. Off-loopback downloads require the bearer token, like the rest of the wire.

## Browser-local storage

Interface preferences are stored in the browser's `localStorage` for the site origin. This is browser state, not filesystem state: it is not in the data home, not in a transcript, and not shared between browsers or devices.

| Key | Values | Default when absent | Preference |
| --- | --- | --- | --- |
| `omp-web:theme` | `system`, `dark`, `light`, `catppuccin-mocha`, `catppuccin-latte`, `omp-dark`, `omp-light` | `system` | theme palette |
| `omp-web:font-size` | integer from 12 to 18 | `15` | root font size |
| `omp-web:history` | JSON array of up to 100 prompt strings | empty | prompt history ring |
| `omp.sidebarVisible` | `true` or `false` | `true`, except a viewport 720px or narrower starts `false` | roster sidebar visibility |
| `omp.sidebarGroupsCollapsed` | JSON array of collapsed group keys | empty, all groups open | roster group collapse state |
| `omp.sidebarUsage` | `true` or `false` | `false` | usage panel above the roster footer |
| `omp.notifyEnabled` | `true` or `false` | `false` | desktop notifications |
| `omp.view` | `work` or `analysis` | `work` | top-level view |
| `omp.txSidebarVisible` | `true` or `false` | `true` | Analysis sidebar visibility |

- Preferences are keyed by origin. The same fleet opened on another port or hostname is another origin and starts from defaults.
- Corrupt or out-of-range values fall back to defaults: an unrecognized theme resolves to `system`, a font size outside the range resolves to 15, a malformed collapsed-groups list opens all groups, and unparsable prompt history starts empty.
- Clearing site data for the origin resets every key above and discards prompt history. Nothing else is affected, because no session or fleet data lives here.
- Agent settings are not browser preferences. They persist through the omp stack in `config.yml`, as described above.

The [web preferences guide](/configuration/web-preferences/) explains each preference and its controls, and the [keyboard shortcuts reference](/reference/keyboard-shortcuts/) covers prompt-history recall.

## Build and development outputs

These paths exist only in a source checkout and are all gitignored. None of them are needed to run an installed omp-web.

| Path | Contents | Produced by |
| --- | --- | --- |
| `dist/` | the built web UI; the fleet serves it from disk before falling back to its embedded copy | `bun run build:web` or `bun run build` |
| `dist-bundle/` | the installable bundle `cli.js` plus the copied UI assets | `bun run build` |
| `fleet/embedded-dist.ts` | a stub in the tree; a build replaces it with the embedded asset map and restores the stub when it finishes | `bun run build` |
| `dist-release/` | release staging: `omp-web-<version>.tgz`, `release-manifest.json`, and `notes.md` | the release script |
| `omp-web-<version>.tgz` in the repository root | the packed tarball, moved into `dist-release/` during a release | `bun pm pack` |
| `.bench/` | `history.jsonl` benchmark records and the `baseline` pointer | `bun run bench` |
| `test/.fixture/` | `stats.db` plus an `agent/sessions/` tree used by the statistics tests | `bun run tx-fixture`, or the test suite itself |
| `docs/dist/`, `docs/.astro/` | the built documentation site and the Astro cache | `bun run build:docs` or `bun run dev:docs` |
| `omp-session-*.html` in the repository root | an export written by a session daemon whose process working directory is the repository root | the `/export` command |

In a source checkout, the fleet's development runners keep their state outside the repository: `<config directory>/dev-fleets/<slug>-<hash8>/fleet-state.json` plus its lock, where the slug is the worktree basename and the hash is derived from the worktree realpath. The main checkout's development state can seed a new worktree's file once, and each worktree's state then diverges. Config and the managed worktree root stay shared.

## Protection, deletion, and persistence

| If you remove | Consequence | Recovery |
| --- | --- | --- |
| `~/.omp-web/install/` | the `omp-web` symlink dangles and the command fails | reinstall with the installer |
| `config.json` | the fleet serves with defaults, and an interactive launch offers setup again | re-run the offer or restore the file |
| `fleet-state.json` | registrations, roster entries, and their ids are gone; transcripts and repository files are untouched | register projects again |
| `<state file>.lock` while a fleet runs | the lock is the only thing preventing two writers on one state file | never do this; stop the fleet instead |
| a managed worktree directory by hand | the roster row points at a missing directory | use the guarded delete flow, which removes the row and the directory together |
| a transcript | that conversation is gone, and nothing can rebuild it | restore it from a backup copy of the `.jsonl` file |
| a stored session directory under `logs/` by hand | the fleet store and the read-only browsing view lose that lineage | do not; use the purge route for stored history you want gone |
| a clone workspace volume by hand | the roster row points at a volume the provider no longer owns, and the store can no longer be cross-checked against it | delete the workspace through `omp-web rm-worktree <daemon-id>`, which runs the verification gate |
| `<transcript>.lock` while a session daemon runs | two writers could open one transcript | never do this; stop the session daemon instead |
| `stats.db` | analytics lose history until the next sync; transcripts are unaffected | run a statistics sync |
| browser site data | preferences reset and prompt history is lost | reconfigure the interface |

Protection notes:

- The fleet state file can contain dial-in bearer tokens and the enrollment digests that authenticate clone workspaces. Keep the data home readable only by you, and do not paste the file into bug reports.
- Deleting or hand-editing the state file while a fleet is running has no lasting effect, because the owning fleet rewrites it from memory on its next mutation. Stop the fleet first.
- The config file can hold spawn templates, a spawn hook, the browser access token digest, and provider profiles with secret references. Template commands run through `sh -c` when a session daemon starts, so edit the file only yourself.
- The log store is never garbage-collected. Verified read-only history and orphaned workspace subtrees stay until an operator purges them, so plan for the growth that durable history implies.
- The locks are advisory pidfiles. A lock whose holder is gone is broken automatically; a lock whose holder is alive is a signal to stop or reuse that process, never to delete the file.
- omp-web never deletes repository files, transcripts, or the statistics database on its own. Project removal deregisters, worktree deletion is explicit, guarded, and limited to fleet-managed worktrees, and clone workspace deletion runs its verification gate first.

## Related

- [First run](/getting-started/first-run/)
- [Installation](/getting-started/installation/)
- [Updates](/operations/updates/)
- [Data and state management](/configuration/data-and-state/)
- [Session persistence](/concepts/session-persistence/)
- [Create and adopt worktrees](/fleet/worktrees/)
- [Clone workspaces](/fleet/clone-workspaces/)
- [Provider profiles](/configuration/provider-profiles/)
- [Sandboxed session runtime](/advanced/sandbox-runtimes/)
- [Stored sessions](/analysis/stored-sessions/)
- [Browse historical transcripts](/analysis/transcripts/)
- [Sync the statistics database](/analysis/stats-sync/)
- [Environment variables and precedence](/reference/environment/)
- [Configuration schema](/reference/configuration/)
- [Troubleshooting](/operations/troubleshooting/)
