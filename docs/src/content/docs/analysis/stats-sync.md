---
title: Sync the statistics database
description: "Understand how Analysis combines live transcripts with stats.db, when to run a sync, and what each sync failure message means."
---

Analysis reads two sources, and only one of them needs maintenance.

- Every session transcript is a JSONL file read live from the sessions directory. Transcript browsing, per-message details, tool durations, and the longest call come from these files and work without any database.
- `stats.db` is an index built from those transcripts by the `omp stats` command. Token totals, cost, per-turn latency percentiles, and error turns come from it, because they are aggregates that the raw files do not carry.

A session that exists on disk but has no rows in `stats.db` is marked `not synced` in the transcripts sidebar and `not indexed` on its row. It still opens; the Overview simply labels which figures are live and which wait for a sync. See [Session analytics](/analysis/analytics/) for how the labels read.

## What a sync does

A sync runs `omp stats --summary` on the machine that runs the fleet, then re-reads the database. The server spawns the command, waits for it, and reports what it processed:

- `Synced N entries from M files` is the success message shown in the Overview toolbar.
- The transcripts list, the database health, and the open session's analytics all refresh after a successful sync, so a session that was `not synced` becomes fully indexed without a reload.
- Transcripts themselves are never modified by a sync. The command reads them and records what it computes in the database, and the browser never writes to `stats.db` directly.

Nothing in the transcript views requires a sync. Syncing is what unlocks the database-backed figures and clears the `not indexed` markers.

## Running a sync

Three controls run the same operation:

- **Sync now** in the transcripts sidebar footer.
- **Sync stats DB** in the Overview toolbar.
- **Sync now** in the health banner that appears over the detail pane when the database is missing or could not be opened.

Each button shows a busy state while the command runs. A second sync request while one is in flight is refused with `sync already in progress`, because the operation is single-flight per fleet process. A sync that runs longer than ten minutes is killed and reported as `sync timed out`.

## Reading the database state

The transcripts sidebar footer reports the data sources at a glance:

| Line | Meaning |
| --- | --- |
| `dir` | The sessions directory being read. |
| `db` | The database state: `ok`, `missing`, or `error`. |
| `sessions` | Number of main-session transcripts on disk. |

When the state is anything but `ok`, a banner appears over the detail pane:

- **Missing database**: it says the database was not found and suggests running `omp stats` once to build the index. A sync from the banner builds it without leaving the browser.
- **Unreadable database**: it names the path that could not be opened. The path is printed with your home directory shortened to `~`.
- A failed sync from the banner renders as `Sync failed: <message>` next to the button.

## Failure messages

| Message | Meaning |
| --- | --- |
| `stats.db not found` | No database exists yet. Run `omp stats` on the fleet host, or use **Sync now**. |
| `stats.db could not be opened at <path>` | The file exists but cannot be read, for example a permissions or file-format problem. |
| `sync already in progress` | Another sync is running in the same fleet process. Wait for it to finish. |
| `sync timed out` | The command exceeded its ten-minute limit and was killed. Check the host and the size of the transcript store, then retry. |
| `omp stats failed` | The command exited with a nonzero status. The server records the tail of its output for inspection; check that the `omp` CLI works on the fleet host. |
| `omp binary not found` | The `omp` CLI is not on the server's `PATH`. Install it with `npm i -g @oh-my-pi/omp-stats` or add it to `PATH`. |
| The database lies outside the config root | The server cannot point the CLI at a database outside your home directory, so the sync is refused with an explanation. Move the database under your home directory or stop overriding the config directory. |

Sync is also the documented first response to the stale-statistics symptom in [Troubleshooting](/operations/troubleshooting/).

## Safety and provenance

- Reads are read-only. If the database cannot be opened read-only, for example when its write-ahead log sidecars are missing, the server serves a temporary copy instead of touching the original, and its health report notes that the current view comes from a copy.
- Sync is the only operation that changes the database, and it does so by running the `omp stats` command, exactly as if you ran it yourself.
- The database and sessions locations come from the `omp` configuration, and a sync points the CLI at the same files the browser reads. The full precedence is owned by [Environment variables and precedence](/reference/environment/) and the locations themselves by [Files and directories](/reference/files/).

## Related

- [Session analytics](/analysis/analytics/)
- [Browse historical transcripts](/analysis/transcripts/)
- [Troubleshooting](/operations/troubleshooting/)
- [Files and directories](/reference/files/)
- [Environment variables and precedence](/reference/environment/)
