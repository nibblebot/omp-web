---
title: Browse historical transcripts
description: "Use the Analysis view to search, filter, and read every stored session transcript, including sessions whose files are missing or not yet indexed."
---

The Analysis view is the historical browser for stored sessions. It lists every main-agent transcript in the fleet host's sessions directory, opens one at a time, and renders the raw conversation from disk. Session transcripts are durable: they outlive the session daemons that wrote them, so this view keeps working for checkouts and processes that no longer exist. The model behind that durability is described in [Session persistence](/concepts/session-persistence/).

The Analysis view is part of the fleet-served UI, reached with the Work/Analysis switch, and it replaces the roster column with its own transcripts sidebar.

## Entering Analysis

The left sidebar opens with the Work/Analysis mode switch. Choosing Analysis replaces the roster with the transcripts sidebar and the detail pane. The choice is remembered per browser, so a reload returns to the same view, and the transcripts sidebar has its own persisted open or closed state with its own close button.

Loading the page with a URL ending in `#/s/<file>` opens Analysis with that transcript already selected. Selecting a transcript in the sidebar writes the same kind of hash, so the address bar always names the open file. Returning to Work clears the hash.

Once opened, the Analysis view stays mounted while you switch to Work and back, which preserves the session list, its scroll position, the search text, the project filter, and the open transcript.

## The sessions sidebar

The list shows one row per main-agent session transcript. Subagent transcripts are not rows here; they appear per session in the Subagents tab. A session that has rows in `stats.db` but no file on disk still gets a row, so deleted or archived history remains visible as long as the database still has rows for it.

Above the list:

- A count badge showing the number of rows currently rendered, replaced by an ellipsis during the first load.
- A project filter listing **All projects** and one entry per project group.
- A search box with the placeholder `Search title, cwd…`.

Details of the list:

- **Search** matches the session title or the recorded working directory, case-insensitively, as a substring. It runs on the server after a short debounce, so partial typing does not fire a request per keystroke.
- **The project filter** narrows the list in the browser to one group and composes with the search. Groups are keyed by the session's recorded working directory, falling back to the project folder name, and labeled with the folder name.
- **Grouping** renders a sticky header per group, with sessions keeping the server's newest-first order inside the group. Groups are ordered by their most recent member.
- **A row** shows the session title, or the file name when the title is unknown; a relative time, or `not synced` when the session has no database rows; the project folder; a metrics line of turns, tool calls, tokens, and cost; and tags. The tags are the error-turn count when nonzero, `not indexed` for a session missing from `stats.db`, and `missing` for a session whose file is gone from disk.
- **Ordering and caps** put on-disk sessions first by file modification time. Sessions known only through the database are placed among their era using their last recorded timestamp. The list is capped at 2000 rows and appends `showing first N of M sessions` when the cap cuts it.

The list can also show `No sessions yet` when nothing has ever been recorded, `No sessions match.` when a search or project filter excludes everything, and a note that a refresh failed while the previous list stays on screen.

## The detail pane

Selecting a session opens its detail pane. The header shows the session title, the transcript file path relative to the sessions directory, the project folder, the recorded working directory when present, the session span from first to last recorded timestamp, and the user message count and character count.

Three tabs split the view:

- **Overview** carries the analytics for this session, described in [Session analytics](/analysis/analytics/).
- **Transcript** renders the raw entries, described below.
- **Subagents** lists the session's subagent transcripts, described in [Subagent activity and transcripts](/analysis/subagents/).

The tabs stay mounted while you switch, so transcript pages that have already loaded survive a trip to another tab.

## The Transcript tab

The transcript loads entries from the session file in pages of 200 as you scroll toward the end. There is no load-more button. A day separator appears whenever the local calendar day changes between consecutive entries, and only the rows near the viewport are rendered, so very long sessions stay responsive.

The toolbar offers:

- **Tool filter**, a dropdown of the session's tool names, plus **clear filter** when one is set. The filter keeps assistant turns that call the chosen tool and the results those calls produced. Clicking a tool row in the Overview table jumps here with that tool already selected.
- **expand all** and **collapse all** for the collapsible entry sections.
- **hide system entries**, which drops non-message entries from the rendered stream.
- A progress label such as `120 of 431 entries`, where the total counts raw lines in the file, including any line that could not be parsed.

Entries render from their original records. Assistant messages keep their thinking blocks collapsed, tool calls pair with their results, and a collapsible `usage` section on an assistant entry exposes input, output, cache read and write, reasoning, and cost figures as far as they were recorded. See [Tool calls, diffs, and images](/sessions/tools-diffs-images/) for how tool activity reads in the live conversation.

Load failures show `Failed to load transcript` with a **Retry** button that refetches the current window, and a session with no entries says `No entries in this session.` While a page is loading, a short hint indicates progress.

Subagent transcripts open in this same tab, tagged `subagent transcript` with a **back to main** button. The tool filter does not apply to a subagent transcript, and it is cleared when one opens.

## Live files and the statistics database

The transcript itself is read live from the session file, so it needs no database and reflects the file as it exists now. Opening a session never writes to it, and paths are confined to the sessions directory.

The metrics mixed into this view have two sources:

- The transcript entries, the title, and every per-message detail come from the session file.
- The turns, tool call counts, tokens, and cost on list rows and the Overview cards come from `stats.db` for synced sessions. A session that has never been indexed shows zeroed metrics with the `not synced` marker and the `not indexed` tag, and its Overview explains which numbers are live and which wait for a sync.

The sidebar footer summarizes the data sources: `dir` is the sessions directory being read, `db` is the database state (`ok`, `missing`, or `error`), and `sessions` is the number of main sessions on disk. The footer also carries the **Sync now** button. Both the footer and the health banner at the top of the detail pane are covered in [Sync the statistics database](/analysis/stats-sync/).

## Missing and archived sessions

History outlives files in both directions.

- **A row can outlive its file.** When a transcript was deleted or archived away but `stats.db` still has rows for it, the row stays with a `missing` tag. Selecting it cannot load a detail view, and the browser returns to the list instead of showing a broken session. The transcript, stats, and subagent endpoints all refuse a session whose file is not on disk.
- **A deep link can outlive its session.** Following a `#/s/<file>` link for a file that is gone falls back to the list once an unfiltered, untruncated session list proves the file is absent. While a search narrows the list, the list is still loading, the request failed, or the response was truncated, the absence proves nothing and the fallback waits.

The sessions directory location and how to inspect the transcript files are covered in [Files and directories](/reference/files/).

## Related

- [Session analytics](/analysis/analytics/)
- [Subagent activity and transcripts](/analysis/subagents/)
- [Sync the statistics database](/analysis/stats-sync/)
- [Session persistence](/concepts/session-persistence/)
- [Files and directories](/reference/files/)
