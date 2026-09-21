---
title: Stored sessions and orphans
description: "Read the fleet's mirrored session transcripts in the Analysis view, see why browsing never wakes compute, and know how orphaned history is listed, purged, and resumed onto a fresh clone."
---

The fleet log store is a durable copy of the session lineage logs that managed session daemons stream to the fleet. It exists because those daemons cannot be asked for files: a clone workspace daemon runs in a provider sandbox and has no inbound service, so it dials the fleet's callback pair outbound and streams its session files instead. The store is what the Analysis view browses under **Fleet store**, and it is the only transcript source for a workspace that no longer exists.

This is a different surface from the fleet host's own transcripts, which live in the sessions directory on disk and are covered in [Browse historical transcripts](/analysis/transcripts/). Stored rows come from the store and carry no `stats.db` metrics; local rows come from the host's sessions directory and do.

## The store on disk

The store root sits next to the fleet state file, at `<state dir>/logs` (default `~/.omp-web/logs`).

| Path | Contents |
| --- | --- |
| `logs/<workspaceId>/<sessionId>/<relpath>` | Raw lineage bytes, byte-identical to the daemon's file. `relpath` is POSIX-relative to the daemon's sessions directory. |
| `logs/<workspaceId>/<sessionId>/index.json` | Per-session sidecar: `version`, `workspaceId`, `sessionId`, and a `streams` map keyed by relpath with `generation`, `ackedOffset`, and `eof`. |
| `logs/<workspaceId>/readonly.json` | Written when the workspace passes the verified deletion gate. From that point the store refuses every write to the subtree. |

A stored file is classified the same way an export manifest classifies it: `<sessionId>.jsonl` at depth 1 or 2 is the `main` session file, other `.jsonl` files under a main session's artifact directory are `subagent` transcripts, `__advisor*.jsonl` files are `advisor` recordings, and any other shape is `metadata`.

## How streaming stays durable and ordered

The daemon half tails the whole lineage subtree and sends one `frame` envelope per lineage file, on a virtual stream named `logs/<sessionId>/<relpath>`. Each chunk carries `offset`, `generation`, base64 `data`, and `eof`. The fleet ingests chunks in arrival order and answers with `log_ack` controls carrying durable offsets, batched at up to 64 chunks or one second. A `log_gap` control asks the daemon to re-stream a byte range.

- **fsync before ack.** `ingest` returns an offset only after the appended bytes and the index are durable on disk, so an acknowledged offset is a resume point the daemon can trust. The daemon persists the watermarks it receives in `.omp-log-tail.json` beside its sessions directory, so a daemon restart resumes from the last acked offset instead of re-sending the file.
- **Contiguous offsets.** A chunk whose offset equals the durable length appends. Any other offset is a result, not an error:

| Chunk offset | Result | What happens |
| --- | --- | --- |
| Equal to the durable length | `acked` | Bytes append, the index updates, and the offset becomes the ackable resume point. |
| Greater than the durable length | `gap` | Nothing is appended and the fleet asks the daemon to re-stream `[from, to)`. |
| Lower than the durable length | `duplicate` | Dropped silently: a post-reconnect resend below the acked offset. |
| Older `generation` | `obsolete` | Dropped silently: the stream has moved on. |
| Newer `generation` | accepted | Stored bytes truncate and the stream resyncs from offset 0. |

- **Repair on load.** When the store loads, it reconciles the sidecars with the bytes on disk and persists the corrections: a torn trailing write is cut back to the last complete line, a file longer or shorter than its index is reconciled, a file with no index entry is adopted, a missing index is rebuilt from the files, a vanished stream resets to offset 0, and a leftover temp file is removed. The repairs are reported in the store's load report, so drift is visible instead of silent.
- **The workspace wins on session deletion.** A `session_deleted` control purges that session's stored subtree, because the workspace deleted it first. A workspace that already passed verification is read-only, so the purge is refused and its history stays intact.

## Browsing the store in Analysis

The Analysis view mounts the store browser under the transcripts list, in the same sidebar scroll surface.

### Sidebar rows

- The section header reads **Fleet store** with a count of stored workspaces, and the footer reads `fleet store` / `read-only browse`.
- One workspace expands at a time. A workspace row shows its id, a provenance line (project, kind, profile, branch, pinned revision, and source kind when known), its session count, and its durable bytes.
- Expanding a workspace lists its sessions: title when a stored head names one, session id, relative time, bytes, file count, and per-kind file counts. A session whose index lists bytes that are missing from disk shows `N assets unavailable`.
- Chips on a workspace row are `fleet-stored` and `deleted workspace: view only`. The stored browse surface reports view-only for every stored workspace row, so that second chip renders on all of them; the detail header keys the same chip off workspace identity instead and shows it for a workspace with no live roster entry. The detail header also shows `read only` for a workspace that passed deletion verification without being orphaned.

### Session detail

Selecting a session opens the detail pane for the route `#/stored/<workspaceId>/<sessionId>`. The header carries the title or session id, the workspace id, provenance facts, last activity, and durable bytes.

- Files are grouped as **Main session**, **Subagents**, **Advisor**, and **Metadata**. A file indexed but absent from disk is not clickable and reads `missing from fleet store: unavailable`; a complete file shows its byte count and an `eof` marker.
- The transcript pane pages through the stored JSONL in windows of 200 entries, with a raw mode that shows the stored bytes. There is no tool filter here, because store files have no `stats.db` rows to derive tool names from, and there is no download action: the pane is read-only by design.
- Selecting a session or workspace never contacts a session daemon.

### Read routes

The browser reads four read-only routes. An error answers `{ error: <message> }`, with HTTP 400 for a malformed identity, relpath, or parameter and HTTP 404 when the workspace, session, or file is not in the store. Examples: `session not found in fleet store` and `stored file <relpath> is unavailable (missing on disk)`.

| Route | Returns |
| --- | --- |
| `GET /ctl/stored/workspaces` | One row per stored workspace: session count, bytes, `readOnly`, `orphaned`, `viewOnly`, provenance, and `resumeClonePath` only for orphaned workspaces. |
| `GET /ctl/stored/sessions?workspaceId=<id>` | One row per stored session, filtered by workspace when the query parameter is present. |
| `GET /ctl/stored/sessions/:workspaceId/:sessionId` | The same row plus the file list, each file with `bytes`, `ackedBytes`, `eof`, and `status` (`stored` or `missing`). |
| `GET /ctl/stored/sessions/:workspaceId/:sessionId/transcript?file=<relpath>&format=parsed\|raw&offset=&limit=` | Parsed pages (default 200 entries, max 500) or the exact stored bytes as `application/x-ndjson`. |

## Read-only browsing never wakes compute

Every method behind this surface is a pure disk read over the store. Browsing stored history never touches a session daemon, the SDK, or provider compute, so opening the session of a stopped, sleeping, or deleted workspace cannot start it. Read-only means read-only in both directions: nothing in the browse path writes to the store.

## Retention, orphans, and purge

Nothing in the store expires on a timer. There is no garbage collector and no scheduled cleanup, and verified history is never deleted from inside the fleet.

| State | How it arises | What removes it |
| --- | --- | --- |
| Verified read-only history | The workspace passed the deletion gate, which flips the store subtree read-only before the volume is removed. | Only an explicit purge. |
| Orphaned history | A roster identity disappeared without a passed verification gate while its store subtree survived. The registry records a `storeOrphan` marker with the reason and the retained clone provenance (source and pinned revision). | Only an explicit purge. |

Two routes manage this, and both sit behind the same browser-auth gate as the rest of `/ctl/*`:

- `GET /ctl/logs/orphans` lists every store subtree with no live roster identity, with its sessions, bytes, `readOnly` flag, and whether a `storeOrphan` marker exists.
- `POST /ctl/logs/purge {workspaceId}` removes that workspace's subtree and clears its orphan marker, answering `{ purged, sessions }`. A live, still-writable workspace is refused with HTTP 409 and `workspace <workspaceId> is live and its store is still writable; purge only applies to orphaned or verified read-only logs`. Without a loaded store the route answers HTTP 503 `fleet log store unavailable`.

## Resume an orphaned session onto a fresh clone

Deleting a workspace does not have to end its conversation. An orphaned workspace's row carries `resumeClonePath`, and only that row offers the **Resume onto fresh clone** action in the detail pane or the sidebar. A session still owned by a live workspace is not resumable through this route.

`POST /ctl/workspaces/:id/resume-clone` takes `{ sessionId, profileId? }` and provisions a fresh volume at the workspace's pinned commit, copies the requested session's stored lineage into the new volume's agent sessions directory, and spawns a daemon with the callback flags and `--resume`. The pin is enforced: an unresolvable source or commit fails the request instead of quietly substituting whatever the source resolves to now.

The fleet answers with a status and a message, and the dialog shows that message verbatim:

| Status | When |
| --- | --- |
| 400 | `sessionId` is missing or malformed. |
| 409 | The workspace is still registered. Live workspaces wake or resume through their own paths. |
| 404 | No resumable provenance was retained, meaning the source or the pinned commit is missing: `no resumable clone provenance for workspace <id> (the source or pinned commit was not retained)`. |
| 409 | The store has no transcripts for that session: `no stored transcripts for session <sessionId> in workspace <workspaceId>`. |
| 503 | No clone provider is configured, clone preparation failed, or the daemon spawn failed. |
| 200 | `{ resumed, sessionId, provisioned: true, materializedFiles, checkoutDir }`. |

The dialog states the limit plainly: the stored transcripts are not the workspace, they contain no working-tree files, and uncommitted working-tree state is unrecoverable once the workspace is gone. On success the UI returns to the Work view, where the new clone workspace appears in the roster.

## Related

- [Browse historical transcripts](/analysis/transcripts/): the fleet host's own sessions directory.
- [Clone workspaces](/fleet/clone-workspaces/): creation, the deletion gate, and provider profiles.
- [Security model](/operations/security/): where the store lives and what protects it.
- [Browser access and sign-in](/operations/browser-auth/): the gate in front of every `/ctl` route.
- [Data and state management](/configuration/data-and-state/): the fleet state directory and its contents.
