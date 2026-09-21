---
title: Clone workspaces
description: "Create, start, stop, wake, and safely delete provider-managed clone workspaces: disposable sandboxes with their own checkout, private home, and transcripts."
---

A clone workspace is a session workspace that an external provider manages: a sandboxed session daemon running on disposable compute with a workspace volume. The volume holds a working clone in `.checkout/` (cloned with `--no-hardlinks` and its own object store, never an alternates link to the source) and a private home in `.home/`, whose `agent/sessions` tree is where the daemon writes transcripts. The fleet mirrors those transcripts into its log store as they stream, so stopping or deleting compute never loses session history.

A clone is one roster entry like any other daemon, and the fleet keeps a private workspace record for it (kind, project, source, pinned revision, profile, desired state, authorized generation, provider handle, deletion state) that never serializes into roster frames. Unlike a [worktree](/fleet/worktrees/), a clone is independent of any local checkout: the source can be a path on the fleet host or a remote URL, and the commit pin is resolved once and reused.

Clone workspaces need a declared [provider profile](/configuration/provider-profiles/). The default fleet has none, so clone routes fail with a typed `unavailable` (HTTP 503), for example `no resolvable provider profile "bwrap-dev" (no matching providerProfiles entry)`. Validate a profile with `omp-web preflight --profile <id>` before the first workspace; what runs inside the sandbox is covered in [Sandboxed session runtime](/advanced/sandbox-runtimes/).

## Create a clone

### From the browser

Open the [fleet sidebar](/fleet/sidebar/), expand a project group, and click **+ Add workspace** (the same button creates worktrees and adopts existing ones). The **Add workspace** dialog opens; switch to the **Clone** tab.

| Field | What it does |
| --- | --- |
| **name** | The roster name, and the source of the default branch: the name lowercased with every run of characters outside `a-z0-9._/-` folded to `-`. A name that folds to nothing becomes `workspace`. |
| **Provider profile** | Required, and never defaulted silently: the select lists `id (provider[, secrets])` entries from the fleet's secret-free catalog. A remembered profile is pre-selected only while it still exists in the catalog. With no profiles configured the tab says `this fleet has no provider profiles configured; clones are unavailable`. |
| **Source** | One of **Project checkout** (the registered project's own path), **Local path…** (`absolute path or ~/… on the fleet host`), or **Remote URL…** (`https://…` or `git@host:…`). |
| **Revision** | A commit SHA or ref (`default: project HEAD`). |
| **Branch** | A branch name (`default: derived from name`). |
| **Start a session now** | Checked, the default until you change it, starts the runtime as soon as preparation finishes; clear it to register the entry asleep. |

Click **Create clone**. With a start requested the dialog tracks **preparing workspace**, **starting runtime**, and **attaching session**; without one it closes as soon as the entry is registered. A failure parks the dialog on an error rung with **Back to edit** and **Edit and retry**: a preparation failure removes the partial entry and volume and reports the typed error, while a start failure after a successful preparation keeps the entry (the volume and pin are durable) with lifecycle stage `failed` and the typed error on the row, and starting again retries in place.

The dialog remembers only the tab kind, the profile id, and the start checkbox, scoped to this browser and fleet origin. Names, sources, revisions, and branches are never persisted.

### From the CLI

```sh
omp-web add-clone <project> <name> --profile <id> \
  [--local <path> | --remote <url>] [--revision <rev>] [--branch <b>] [--no-start]
```

- `<project>` accepts a project id, its canonical path, or its repository basename.
- `--profile <id>` is required. `--local` and `--remote` are mutually exclusive; omit both to clone the registered project's own path.
- The revision is any commit-ish for a local source, or an advertised ref for a remote source, and defaults to the source HEAD. The fleet resolves it once and persists the full commit as the workspace's pinned revision before any provider step, so every retry reuses it instead of re-resolving.
- Start is on by default, mirroring `add-worktree`; `--no-start` prepares the volume and parks the clone asleep.
- On success the command prints the volume path, the daemon id, and the status, or `not started`.

Typed refusals print on stderr, for example `fleet error (503): no resolvable provider profile "bwrap-dev" (no matching providerProfiles entry)`.

## Start, stop, and wake

| Action | Browser | CLI |
| --- | --- | --- |
| Wake or start | Click an asleep clone row (wake, then attach), or **⋯ → Start workspace** | `omp-web start <selector>` |
| Stop | **⋯ → Stop workspace** (two-click confirm) | `omp-web stop <selector>` |
| Delete | **⋯ → Delete workspace…** | `omp-web rm-worktree <daemon-id>` or `omp-web remove <selector>` |

`omp-web start` resolves its selector (a daemon id or an exact roster name) against the roster client-side and refuses an ambiguous name; the control-plane route itself takes a daemon id and rejects entries that are not clones. `omp-web stop` takes a daemon id or an exact name, and clone entries take the proof-bearing stop described below.

Stop is proof-bearing. The fleet revokes the workspace's enrollment first, asks the provider to stop the compute, and reports the entry stopped only after the provider proves that generation's process is gone; a stop that cannot prove termination fails as `conflict` instead of pretending. Stop preserves the checkout and the session logs, sets the roster status to asleep, and clears the lifecycle stage.

Start is inspect-before-act. A running sandbox whose persisted credential is recoverable is reattached at the same generation; a running sandbox with no recoverable binding must be proven terminated before the fleet bumps the generation and starts fresh. An inspect failure blocks replacement rather than recreating the sandbox blind.

Clone rows show the provider's lifecycle stages while a wake runs: **preparing workspace**, **starting runtime**, **connecting channel**, then the ready status dot. If the sandbox dies before its callback pair establishes, the row flips to `error` with the typed message `sandbox stopped before the callback pair established (observed …)` and a **Retry** that re-issues the wake. The [roster status page](/fleet/roster-status/) covers the dots themselves.

## Wake semantics

- Waking a stopped clone resumes its last session. The fleet hands the daemon the resolved main-session file path as `OMP_SESSION_RESUME`, and a cold volume (or a transcript missing from the agent dir) is materialized from the fleet store into `.home/agent/sessions` first, byte-identical and verified before the resume path runs. A never-started clone with no sessions anywhere boots fresh.
- An explicit session pick changes that behavior. Pick a session from the row's session dropdown and an asleep clone wakes into that session; on an already-ready clone the client attaches and switches to that session instead of booting fresh. An explicit pick that exists nowhere is a typed `unavailable`, never a silent empty boot.
- The path-based resume handoff is the bwrap-volume lane. Kubernetes volumes are retained across stop (warm) and receive no fleet-side path hint, and their stored transcripts stay listed for resume either way.

## Delete a clone workspace

Deleting a clone is a separate operation from stopping it and from stopping the current turn. **Delete workspace…** opens the confirm dialog (`Delete clone workspace` / `Delete clone`), and the fleet runs the verified deletion gate, refusing anything it cannot verify.

The gate, in order:

1. **Admission.** A live workspace is refused with `writer_active` and the message to stop current work first. For clones, active work is not observable fleet-side, so a ready entry with a running desired state or a live callback pair is refused rather than risking a mid-turn delete.
2. **Durable marker.** The workspace record is marked `deleting` before any destructive step. A deletion interrupted by a fleet crash reconciles to `delete-pending-retry` on the next boot.
3. **Quiesce with proven stop.** The enrollment is revoked so no further log frames arrive, then the provider must prove the compute stopped; a stop that cannot prove termination blocks.
4. **Git guard.** Against the clone's `.checkout`, with writers stopped: uncommitted or untracked files, stashes, and commits not reachable from any origin ref all block with actionable messages, and unreachable git or an unreadable checkout blocks as unknown status. There is no force override.
5. **Store verification.** Every session must be offset-contiguous and structurally valid in the fleet store, and the store must be byte-identical to the volume's own session tree; an empty store never trivially passes when sessions existed on the volume. A fleet with no readable log store blocks deletion entirely.
6. **Read-only flip**, then **provider deletion**, then **volume deletion**, then **roster removal**. The verified store subtree flips read-only and is kept.

Any failure before verification persists `delete-pending-retry` and retains the workspace, its volume, and its store; run the delete again to retry. When the gate passes, the CLI prints `removed clone workspace daemon <id> (verified <n> sessions)`. A never-prepared clone has no checkout to guard, so the store and volume checks are authoritative.

Uncommitted working-tree state is lost either way: session transcripts are not a source backup.

## Retention and orphans

Verified history is never garbage-collected; retention is explicit and manual. A workspace deleted without a passed verification gate leaves its store subtree as an orphan, listed by `GET /ctl/logs/orphans` and removed only by the explicit `POST /ctl/logs/purge {workspaceId}`. Read-only browsing never wakes compute, and resuming a deleted workspace's session onto a fresh clone is the explicit `POST /ctl/workspaces/:id/resume-clone` action, which answers a typed `unavailable` when no clone provider is wired rather than faking a spawn. [Stored sessions](/analysis/stored-sessions/) covers the store, browsing, and purge.

## Related

- [Provider profiles](/configuration/provider-profiles/): declare the bwrap or Kubernetes environments clones run on.
- [Sandboxed session runtime](/advanced/sandbox-runtimes/): what actually runs inside a clone.
- [Stored sessions](/analysis/stored-sessions/): transcripts, browsing, and retention.
- [Understand roster status](/fleet/roster-status/)
- [Start, stop, wake, and remove session daemons](/fleet/session-daemon-operations/)
- [CLI commands and flags](/reference/cli/)
