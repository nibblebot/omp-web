---
title: Session analytics
description: "Read per-session tool counts, timing, latency percentiles, token totals, cost, and error turns in the Overview tab, and know which numbers come from stats.db."
---

The Overview tab of a session detail summarizes one stored session: how many tool calls it made, how long they ran, the slowest call, the per-turn latency, token totals, cost, and error turns. It is the Analysis view's per-session report, available in fleet mode only, alongside [Browse historical transcripts](/analysis/transcripts/) and [Subagent activity and transcripts](/analysis/subagents/).

Analytics mixes two sources on purpose, and the tab labels which one produced each figure.

## Two sources: the session file and stats.db

- The **session file** is the raw transcript on disk. It is read live and needs no database.
- **`stats.db`** is the index built by the `omp stats` command. It carries the token totals, cost, per-turn durations, and error turns that the transcript alone cannot aggregate cheaply.

A session that has rows in the database shows real numbers without qualification. A session that exists only as a file shows `not synced` where its relative time would be and carries the `not indexed` tag, and the Overview prints a note explaining the split: tool counts and durations are read live from the transcript, while token, cost, and error figures come from `stats.db` and stay empty until the session is synced. Each affected card and panel carries a small `live` or `db` marker saying which side produced it.

The sync button in the Overview toolbar runs the same operation as the sidebar's **Sync now** and reports `Synced N entries from M files` on success. Failures render next to the button with a **Dismiss** action. The full procedure, including what each failure message means, is in [Sync the statistics database](/analysis/stats-sync/).

## The summary cards

| Card | Value | Source |
| --- | --- | --- |
| Tool calls | Total tool calls in the session. | `stats.db` when synced, else the transcript. |
| Longest call | The slowest timed tool call, as tool name plus duration. The tooltip adds the tool call ID. | The transcript. |
| Session span | First to last recorded timestamp. | `stats.db` when synced, else the transcript. |
| Tokens | Total tokens recorded for the session. | `stats.db` only. |
| Cost | Total cost recorded for the session. | `stats.db` only. |
| Error turns | Error turns stored for the session, capped at 100 in `stats.db`. The sidebar row tag shows the true count from the database aggregate, so the two can differ for error-heavy sessions. | `stats.db` only. |

The Longest call card and the latency panel render a dash when nothing has been measured. The token, cost, and error-turn cards are database aggregates, so a session with no database rows shows zero values there; the `db` marker and the split note are what tell you those zeros are an absence of records, not a measured result.

## Tool breakdown

The tool table lists every tool the session used, sorted by call count, with columns for calls, errors, average execution time, total execution time, and argument size in characters. The bar under each row is sized against the largest total execution time in the table, so it compares tools against each other rather than against a fixed scale. Hovering the bar reveals the total, average, and maximum durations plus the number of pending calls.

How these numbers are computed:

- **Durations are execution spans**: the time from a tool call's execution-start marker to the matching tool result. They measure the tool itself, never the surrounding model turn, which can contain several calls. A call with no execution-start marker is counted but contributes no duration, and a call whose result has not arrived yet is counted as pending.
- **Errors** are tool results flagged as errors.
- **Argument size** is the character count of the serialized arguments.
- With a synced session, call counts, error counts, and argument sizes come from `stats.db`, while durations, pending counts, and the longest call always come from the transcript. Without a sync, the count columns fall back to the transcript pass.

Clicking a tool row (or pressing Enter or Space on it) switches to the Transcript tab with the tool filter applied, so the timing table is also a way to find the calls themselves.

## Latency per turn

The latency panel reports p50 and p90 of the per-turn durations stored in `stats.db`. Percentiles use the nearest ranked duration, not an interpolated value. Durations are only available for synced sessions, so an unindexed session shows dashes here even though its tool durations above are live.

Use the two panels together to separate causes: a high p90 with short tool calls points at the model turns themselves, while a high longest call points at a specific tool invocation.

## Error turns

The error turns panel lists the failing turns with their timestamp, model, and error message, newest first, limited to the latest 100 rows in `stats.db`. A session with no stored errors says `No error turns.` The panel is a database view only; the Transcript tab marks errors inline on the assistant entry instead.

## When analytics cannot load

- If the per-session request fails, the tab shows `Could not load analytics: <message>`; the session header adds `stats unavailable`.
- The sidebar's `db` line reports `missing` or `error` when the database cannot be read at all. The health banner over the detail pane explains the specific case, and sessions without database rows still open with live transcript data.
- A session whose file was deleted opens from the list only as a `missing` row; the detail view refuses it and returns to the list, as described in [Browse historical transcripts](/analysis/transcripts/).

## Related

- [Browse historical transcripts](/analysis/transcripts/)
- [Sync the statistics database](/analysis/stats-sync/)
- [Context, tokens, and cost](/analysis/context-tokens-cost/)
- [Subagent activity and transcripts](/analysis/subagents/)
