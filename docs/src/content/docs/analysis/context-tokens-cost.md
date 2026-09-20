---
title: Context, tokens, and cost
description: "Read the attached session's context window, token counts, and cost from the session bar, the Session stats modal, and each assistant message."
---

This page covers the figures for the session currently attached to the browser: how full its context window is, how many tokens it has spent, and what it has cost. They come from the session daemon's live session state, so they describe that one conversation and update as it runs. Two neighboring pages cover different questions: [provider usage limits](/analysis/provider-usage/) are account-level rate-limit windows reported by the provider, and [session analytics](/analysis/analytics/) are historical numbers read from transcripts and `stats.db`.

Because these numbers describe the live session, they need no statistics database; they come from the attached session daemon. To compare sessions, switch to that session first.

## The context segment

The session bar sits directly above the composer. At its right side, a `ctx N%` segment reports how much of the model's context window the conversation currently occupies.

- The percentage is the estimated context tokens divided by the model's context window.
- Hovering the segment shows the absolute pair, for example `128k / 200k tokens`.
- The segment is absent when the session has not reported context usage.

The percentage is colored by thresholds ported from the terminal status line. Each level trips on whichever comes first, a percent of the window or an absolute token count:

| Level | Trips at |
| --- | --- |
| warning | 50% of the window or 150k tokens |
| purple | 70% of the window or 270k tokens |
| error | 90% of the window or 500k tokens |

Because either condition can trip a level, the same token count colors differently across models. On a 200k window the warning level arrives at 50%, around 100k tokens, so 150k tokens is already past it. On a 1M window the absolute threshold wins and warning arrives near 15%, at 150k tokens. Read the tooltip when the color changes and the exact numbers matter.

A high reading is the signal to compact or start a fresh session before the window overflows. Compaction and recovery actions are described in [Compaction, retry, and recovery](/sessions/recovery/).

## Cost and token totals in the session bar

Next to the context segment, a stats segment shows the running totals, for example `$0.42 · ↑1.2k ↓340`. The dollar amount is the session's cumulative cost, the up arrow is cumulative input tokens, and the down arrow is cumulative output tokens. Clicking the segment opens the Session stats modal. The segment appears only after the session daemon has reported statistics.

## The Session stats modal

Open the modal by clicking the stats segment, or by running `/usage`, `/context`, or `/tools`. In omp-web all three slash commands open this one modal; the complete table of commands is owned by [Slash commands](/reference/slash-commands/).

The table at the top summarizes the whole session:

| Row | Meaning |
| --- | --- |
| messages | Total messages, with the user and assistant split in parentheses. |
| tool calls | Number of tool calls the agent has made. |
| input tokens | Cumulative input tokens. |
| output tokens | Cumulative output tokens. |
| reasoning tokens | Cumulative reasoning tokens. |
| cache read/write | Cumulative cache read and cache write tokens. |
| total tokens | Sum of the token buckets. |
| premium requests | Requests counted against a provider's premium-request allowance. |
| cost | Cumulative cost in dollars, shown with four decimals. |
| context | Context tokens out of the context window, with the percentage, when the session reports context usage. |

Below the table:

- **Compact now** runs compaction immediately instead of waiting for a threshold. See [Compaction, retry, and recovery](/sessions/recovery/).
- **usage reports** opens the [provider usage limits](/analysis/provider-usage/) modal.
- The **auto-compaction** checkbox toggles automatic compaction for the session.
- The **Context breakdown** section draws a stacked bar whose segments are sized against the context window: system prompt, tools, system context, skills, and messages. The legend repeats each category with its token count, and a line underneath shows `used`, the window, the percentage, and whether the reading is `anchored` to a provider-reported count or `not anchored`. When the session cannot produce the breakdown, the section is absent.
- The **Tools** section lists the tools offered to the session with truncated descriptions. It appears only when tool information is available.

## Per-turn usage

Each settled assistant message in the live conversation can carry a one-line usage footer, for example `↑1.2k ↓340 · cache 5.1k/0 · ttft 0.8s · 425 tok/s`. Segments with zero or absent values are dropped, so a message without cache activity shows only the token arrows. Messages with no reported usage get no footer at all. These figures describe one request: input and output tokens, cache read and write, time to first token, and output throughput.

The historical transcript view renders per-message usage differently, as a collapsible `usage` section on each assistant entry with input, output, cache read, cache write, reasoning, cost, and prompt and non-message context tokens where present. That is described in [Browse historical transcripts](/analysis/transcripts/).

## Units and missing values

Token counts use compact forms: whole numbers below a thousand, then `1.2k`, `340k`, and `1.2M`. Costs gain precision as they shrink: no decimals at a hundred dollars or more, two decimals from a dollar to a hundred, four decimals from a cent to a dollar, five decimals below a cent, and a fixed `$0.00` at exactly zero. In the Analysis views, a null measurement renders as a dash rather than a zero, so an absent number is never confused with a measured one.

## Related

- [Provider usage limits](/analysis/provider-usage/)
- [Session analytics](/analysis/analytics/)
- [Browse historical transcripts](/analysis/transcripts/)
- [Compaction, retry, and recovery](/sessions/recovery/)
- [Slash commands](/reference/slash-commands/)
