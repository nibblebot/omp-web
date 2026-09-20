---
title: Analysis and usage
description: Inspect current context, provider limits, and historical fleet activity.
---

Analysis separates three kinds of information that answer different questions:

- Current-session context, token counts, and cost describe the attached conversation.
- Provider usage reports show account-level rate-limit windows reported by configured providers.
- Historical analytics summarize session transcripts, tool calls, latency, errors, subagents, tokens, and cost.

The first two come from the attached session daemon. The historical views read through the fleet's statistics service, over every transcript the fleet host has recorded.

Historical views can read live JSONL transcripts and synchronized `stats.db` records. Missing, archived, or not-yet-synchronized sessions can therefore differ between views. The interface identifies provenance where that distinction matters.

## In this section

- [Context, tokens, and cost](/analysis/context-tokens-cost/) reads the attached session's usage meters and cost.
- [Provider usage limits](/analysis/provider-usage/) opens account-level rate-limit reports.
- [Browse historical transcripts](/analysis/transcripts/) searches and reads stored session files.
- [Session analytics](/analysis/analytics/) covers tool counts, timing, latency percentiles, and error turns.
- [Subagent activity and transcripts](/analysis/subagents/) follows subagents live and historically.
- [Sync the statistics database](/analysis/stats-sync/) explains when to sync and what each failure message means.
