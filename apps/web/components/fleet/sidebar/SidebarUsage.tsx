import { createEffect, For, onMount, Show, untrack, type Component } from "solid-js";
import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import { createNow } from "../../../activities/clock";
import { isPageVisible } from "../../../page-visibility";
import { refreshUsageReports, state, USAGE_AUTO_REFRESH_MS } from "../../../state";
import {
	formatTimeRemaining,
	resolveElapsedFraction,
	resolveUsedFraction,
	usageAccountTitle,
	usageBrand,
	usageLimitTitle,
	type UsageBrand,
} from "../../../usage/usage";
import {
	AnthropicLogoIcon,
	OpenAILogoIcon,
	OpenCodeLogoIcon,
	RefreshIcon,
	type IconProps,
} from "../../ui/icons";

/**
 * Clock tick for the refresh countdown ring and the remaining-time labels. The labels move by the minute and
 * the ring by about a pixel per tick; a faster clock only restyles the sidebar for nothing. The clock stops
 * while the tab is hidden and ticks once when it returns.
 */
const CLOCK_TICK_MS = 5_000;

const BRAND_LOGOS: Record<UsageBrand, Component<IconProps>> = {
	anthropic: AnthropicLogoIcon,
	openai: OpenAILogoIcon,
	opencode: OpenCodeLogoIcon,
};

/**
 * One limit: utilization bar, then time left in its window. Label and percent
 * live in the tooltip. A thin red tick marks how far through the window we
 * are, so usage reads against elapsed time (fill past the tick: ahead of pace).
 */
const UsageBar: Component<{ limit: UsageLimit; now: number }> = (props) => {
	const pct = () => {
		const frac = resolveUsedFraction(props.limit);
		return frac === undefined ? 0 : Math.max(0, Math.min(100, frac * 100));
	};
	const elapsed = () => resolveElapsedFraction(props.limit, props.now);
	return (
		<>
			<div
				class="sidebar-usage-bar"
				data-status={props.limit.status}
				title={usageLimitTitle(props.limit)}
			>
				<div class="sidebar-usage-bar-fill" style={{ width: `${pct()}%` }} />
				<Show when={elapsed() !== undefined}>
					<div class="sidebar-usage-bar-elapsed" style={{ left: `${elapsed()! * 100}%` }} />
				</Show>
			</div>
			<span class="sidebar-usage-reset">
				<Show when={props.limit.window?.resetsAt}>
					{(resetsAt) => formatTimeRemaining(resetsAt(), props.now)}
				</Show>
			</span>
		</>
	);
};

/**
 * Condensed roster-sidebar mirror of the UsageLimitsDialog panel (Phase 9 /usage
 * parity), docked at the bottom of the sidebar when the "usage in sidebar"
 * setting is on. Each provider account (one UsageReport) is a provider logo,
 * one size for every account (a three-bar stack tall), beside its stack of
 * limit bars, each bar followed by the time left in its window. Limit labels,
 * percentages, and reset timestamps are hover text only;
 * warning and exhausted limits tint their bar. Shares the modal's GET
 * /ctl/usage fetch through the usage store slice. While mounted it refreshes
 * USAGE_AUTO_REFRESH_MS after the last fetch settled (any caller's), on a
 * first mount that finds nothing fetched yet, and on the header button, whose
 * ring drains toward the next automatic refresh and stays empty while one is
 * in flight. A refresh over existing data keeps the bars on screen.
 */
export const SidebarUsage: Component = () => {
	const now = createNow(CLOCK_TICK_MS);
	onMount(() => {
		// Fire on mount only when no fetch has landed, failed, or is already in flight.
		if (state.usageReports === null && !state.usageLoading && !state.usageError)
			refreshUsageReports();
	});
	// Auto-refresh only for a tab someone looks at; the clock's first tick after the tab returns finds a stale
	// fetch and refreshes it.
	createEffect(() => {
		const at = state.usageRefreshedAt;
		if (
			at !== null &&
			!state.usageLoading &&
			now() >= at + USAGE_AUTO_REFRESH_MS &&
			isPageVisible()
		)
			untrack(refreshUsageReports);
	});
	/** Fraction of the countdown left: 1 just after a fetch settles, 0 while one is in flight. */
	const remaining = () => {
		const at = state.usageRefreshedAt;
		if (at === null || state.usageLoading) return 0;
		return Math.max(0, Math.min(1, (at + USAGE_AUTO_REFRESH_MS - now()) / USAGE_AUTO_REFRESH_MS));
	};
	/** First load has nothing to show yet, so the body says so; later loads keep the bars. */
	const firstLoad = () => state.usageLoading && state.usageReports === null;
	return (
		<div class="sidebar-usage">
			<div class="sidebar-usage-head">
				<span class="sidebar-usage-title">Usage</span>
				<button
					class="sidebar-icon-btn sidebar-usage-refresh"
					disabled={state.usageLoading}
					onClick={() => refreshUsageReports()}
					title="Refresh usage"
					aria-label="Refresh usage"
				>
					<svg class="sidebar-usage-ring" viewBox="0 0 24 24" aria-hidden="true">
						<circle class="sidebar-usage-ring-track" cx="12" cy="12" r="10" />
						<circle
							class="sidebar-usage-ring-fill"
							cx="12"
							cy="12"
							r="10"
							pathLength="100"
							stroke-dasharray="100"
							stroke-dashoffset={100 * (1 - remaining())}
						/>
					</svg>
					<RefreshIcon class="sidebar-usage-refresh-icon" />
				</button>
			</div>
			<Show when={!firstLoad()} fallback={<div class="sidebar-usage-empty">Loading usage…</div>}>
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
								<div class="sidebar-usage-account" title={usageAccountTitle(report)}>
									{/* Brand logo, one size for every account; unknown providers get their initial. */}
									<Show
										when={usageBrand(report.provider)}
										keyed
										fallback={
											<span
												class="sidebar-usage-logo sidebar-usage-logo--initial"
												aria-hidden="true"
											>
												{report.provider.charAt(0).toUpperCase()}
											</span>
										}
									>
										{(brand) => {
											const Logo = BRAND_LOGOS[brand];
											return <Logo class="sidebar-usage-logo" />;
										}}
									</Show>
									<div class="sidebar-usage-bars">
										<For each={report.limits}>
											{(limit) => <UsageBar limit={limit} now={now()} />}
										</For>
									</div>
								</div>
							)}
						</For>
					</Show>
				</Show>
			</Show>
		</div>
	);
};
