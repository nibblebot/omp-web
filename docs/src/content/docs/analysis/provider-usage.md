---
title: Provider usage limits
description: "Open per-provider rate-limit reports, read utilization windows in the Usage reports modal, and pin the condensed panel into the fleet sidebar."
---

A provider usage report describes your account with a provider, not the session in front of you. It lists the rate-limit windows the provider enforces, how much of each window is used, and when the window resets. Because the report belongs to the account and its credentials, it can change while the session sits idle, and every session authenticated with that provider shares the same limits. Session context and cost are a different subject, covered in [Context, tokens, and cost](/analysis/context-tokens-cost/).

## Where reports come from

The browser asks the attached session daemon for usage reports and mirrors the answer. The session daemon returns one report per provider that supports reporting; a session with no reporting provider resolves to an empty state rather than an error. Providers that do not expose usage data are absent from the list.

The request is a one-shot read, never a poll:

- It is single-flight. While a request is in flight, another refresh is a no-op.
- The provider result is cached upstream for roughly five minutes, so the UI does not schedule timed refreshes.
- Opening the Usage reports modal fires a fetch on mount.
- The condensed sidebar panel fires a fetch on its first mount only when no result has landed, no failure is recorded, and nothing is already in flight. After that, refreshing is manual.

## The Usage reports modal

Open the modal from the **usage reports** button in the [Session stats modal](/analysis/context-tokens-cost/), which is reached with `/usage`, `/context`, or `/tools`. The modal reads from the attached session daemon.

Each provider gets a section:

- The heading is the provider name, followed by the time of the fetch, rendered as `fetched` plus a local timestamp.
- Provider notes appear under the heading when the provider supplies them.
- Each limit row shows the limit label and its window label, for example a five-hour or seven-day window.
- A utilization bar fills from the fraction of the limit used and is clamped at 100%.
- The amount renders as `used / limit` when both are known. Token units use the compact `1.2k` and `340k` forms, percent units append `%`, and other units are grouped with locale separators such as `1,250`. A value the provider omitted renders as a dash.
- A status chip appears beside the label whenever the provider reports a status other than `ok`.
- The reset time renders when the window reports one, as the window's own reset label (defaulting to `resets`) followed by a local timestamp.
- Limit notes appear under the amount.

Empty and failure states:

- `Loading usage reports…` while the fetch is in flight.
- `No usage reporting for the active provider.` when the fetch succeeded with no reports.
- `Failed to load usage: <message>` when the fetch failed. Reopen the modal or fix the reported problem and try again.

## The sidebar usage panel

A condensed version of the same data can be pinned into the fleet sidebar. Turn it on with **usage in sidebar** in Settings under the Interface group. The choice is stored in the browser, so it follows the browser rather than the fleet. See [Settings overview](/configuration/settings/) for the other Web UI preferences.

The panel sits above the sidebar footer and shows one row per limit:

- The limit label with its window label dimmed beside it.
- The used percentage, right aligned.
- A thin utilization bar.
- A status chip when the status is not `ok`.

Amount strings, notes, and reset timestamps stay in the modal. A limit with no usable ratio shows a dash in place of the percentage and leaves the bar empty.

The panel header carries the title `Usage` and a refresh button. Its states are `Loading usage…`, `No usage reporting`, and `Failed to load usage`, the last one exposing the full error message as a tooltip.

The panel is docked into the fleet sidebar, so it shows only while the Work view is active. For the sidebar itself, see [The fleet sidebar](/fleet/sidebar/).

## Related

- [Context, tokens, and cost](/analysis/context-tokens-cost/)
- [Session analytics](/analysis/analytics/)
- [The fleet sidebar](/fleet/sidebar/)
- [Settings overview](/configuration/settings/)
