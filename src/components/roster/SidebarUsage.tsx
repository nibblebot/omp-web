import { For, onMount, Show, type Component } from "solid-js";
import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import { refreshUsageReports, state } from "../../state";
import { resolveUsedFraction } from "../../usage/usage";
import { RefreshIcon } from "../shared/icons";

/** One compact limit row: label (+ dimmed window), right-aligned %, thin bar. */
const UsageRow: Component<{ limit: UsageLimit }> = (props) => {
	const pct = () => {
		const frac = resolveUsedFraction(props.limit);
		return frac === undefined ? undefined : Math.round(frac * 100);
	};
	return (
		<div class="sidebar-usage-row">
			<span class="sidebar-usage-label">
				{props.limit.label}
				{props.limit.window?.label && (
					<span class="sidebar-usage-window">{props.limit.window!.label}</span>
				)}
				{props.limit.status && props.limit.status !== "ok" && (
					<span class="usage-status" data-status={props.limit.status}>
						{props.limit.status}
					</span>
				)}
			</span>
			<span class="sidebar-usage-pct">{pct() === undefined ? "—" : `${pct()}%`}</span>
			<div class="sidebar-usage-bar">
				<div
					class="sidebar-usage-bar-fill"
					style={{ width: `${Math.max(0, Math.min(100, pct() ?? 0))}%` }}
				/>
			</div>
		</div>
	);
};

/**
 * Condensed roster-sidebar mirror of the UsageModal panel (Phase 9 /usage
 * parity): per-provider limit rows as label + percent over a thin utilization
 * bar, docked above the sidebar footer when the "usage in sidebar" setting is
 * on. Shares the modal's one-shot fetchUsageReports relay through the usage
 * store slice; it is never polled, and refresh is manual (header button) or a
 * first mount that finds nothing fetched yet. Amount strings, notes and reset
 * timestamps stay modal-only; non-ok limit statuses render the shared
 * usage-status chip.
 */
export const SidebarUsage: Component = () => {
	onMount(() => {
		// The RPC is one-shot (the SDK caches provider /usage upstream): fire it
		// only when no fetch has landed, failed, or is already in flight.
		if (state.usageReports === null && !state.usageLoading && !state.usageError)
			refreshUsageReports();
	});
	return (
		<div class="sidebar-usage">
			<div class="sidebar-usage-head">
				<span class="sidebar-usage-title">Usage</span>
				<button
					class="sidebar-icon-btn"
					onClick={() => refreshUsageReports()}
					title="Refresh usage"
					aria-label="Refresh usage"
				>
					<RefreshIcon />
				</button>
			</div>
			<Show
				when={!state.usageLoading}
				fallback={<div class="sidebar-usage-empty">Loading usage…</div>}
			>
				<Show
					when={!state.usageError}
					fallback={
						<div class="sidebar-usage-empty" title={state.usageError ?? undefined}>
							Failed to load usage
						</div>
					}
				>
					<Show
						when={(state.usageReports?.length ?? 0) > 0}
						fallback={<div class="sidebar-usage-empty">No usage reporting</div>}
					>
						<For each={state.usageReports}>
							{(report: UsageReport) => (
								<>
									<div class="sidebar-usage-provider">{report.provider}</div>
									<For each={report.limits}>{(limit) => <UsageRow limit={limit} />}</For>
								</>
							)}
						</For>
					</Show>
				</Show>
			</Show>
		</div>
	);
};
