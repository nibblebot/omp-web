---
title: Subagent activity and transcripts
description: "Watch live subagents while a session runs, then read their durable transcripts and advisor logs from the Analysis view."
---

A session can spawn subagents: separate agents that run tasks in parallel and report back to the parent conversation. They appear in two places with different lifetimes. Live activity shows what is running now and lives only in the session daemon's memory. Transcripts are written beside the parent session file and stay on disk, so they outlive the session daemon and are browsable in Analysis.

## Live subagent activity

While a session is attached, live subagent state updates in the running conversation:

- The status bar shows a `subagents (N)` segment whenever the session knows about subagents. Selecting it opens the Subagents modal.
- A strip above the prompt lists the subagents that are currently in flight, one row per running agent. Selecting a row opens the same modal.
- A `task` tool card in the transcript lists the agents spawned by that call.
- The Subagents modal lists every known subagent, most recently updated first, with the agent name, its description or task, its status, and a local timestamp. Agents that are started or running gain steer and abort controls. Selecting a row opens a read-only transcript of that agent, paged as you scroll, with a back action to return to the list.

This live view is session-scoped and in-memory. It works in both fleet and single-session mode whenever a session is attached, it reflects the current session daemon only, and it disappears when that session daemon stops or the live session is replaced. Nothing in it is read from disk.

## Historical subagent transcripts

The durable record appears in the Analysis view, which is fleet mode only. Select a session and open its **Subagents** tab. The tab lists the transcript files recorded for that session:

- The list is built from the session's directory on disk. For a main transcript at `<project>/<name>.jsonl`, every `.jsonl` file under `<project>/<name>/` is listed, including nested directories.
- The advisor transcript, named `__advisor.jsonl`, sits in the same directory and is listed like any other file.
- Each row shows the file name, its size, and a relative modification time. Hovering exposes the path under the sessions directory. Rows are sorted by name.
- An empty directory yields `No subagent transcripts for this session.`, a failed request shows `Failed to load subagents: <message>`, and the list loads with a short hint.

Selecting a row opens that transcript in the Transcript tab, tagged `subagent transcript` with a **back to main** button. Paging, day separators, expand and collapse, and hide system entries all work there. The tool filter is not applied to a subagent transcript and is cleared when one opens. The reading experience is otherwise the one described in [Browse historical transcripts](/analysis/transcripts/).

Notes on what the listing can and cannot show:

- The main session file must still exist on disk for the tab to answer. If it was deleted, the tab reports a load failure even when the directory lingers.
- Files deleted from the directory disappear from the list.
- Paths that resolve outside the sessions directory are skipped, so a symlinked entry cannot expose files from elsewhere.
- Subagent and advisor transcripts never appear as rows in the sessions sidebar. Only main-agent transcripts are listed there; the `__advisor` file name is excluded from that list even when it sits directly in a project folder.

## Related

- [Browse historical transcripts](/analysis/transcripts/)
- [Session analytics](/analysis/analytics/)
- [Projects, worktrees, session daemons, and sessions](/concepts/projects-worktrees-session-daemons-sessions/)
- [Files and directories](/reference/files/)
