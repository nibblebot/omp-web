import { createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js";
import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import { refreshUsageReports, state } from "../../../state";
import {
	formatTimeRemaining,
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

/** Remaining-time labels re-render on this tick; they show minutes at the finest. */
const CLOCK_TICK_MS = 30_000;

const BRAND_LOGOS: Record<UsageBrand, Component<IconProps>> = {
	anthropic: AnthropicLogoIcon,
	openai: OpenAILogoIcon,
	opencode: OpenCodeLogoIcon,
};

/** One limit: utilization bar, then time left in its window. Label and percent live in the tooltip. */
const UsageBar: Component<{ limit: UsageLimit; now: number }> = (props) => {
	const pct = () => {
		const frac = resolveUsedFraction(props.limit);
		return frac === undefined ? 0 : Math.max(0, Math.min(100, frac * 100));
	};
	return (
		<>
			<div
				class="sidebar-usage-bar"
				data-status={props.limit.status}
				title={usageLimitTitle(props.limit)}
			>
				<div class="sidebar-usage-bar-fill" style={{ width: `${pct()}%` }} />
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
 * warning and exhausted limits tint their bar. Shares the modal's one-shot GET
 * /ctl/usage fetch through the usage store slice; it is never polled, and
 * refresh is manual (header button) or a first mount that finds nothing
 * fetched yet. Only the remaining-time clock ticks.
 */
export const SidebarUsage: Component = () => {
	const [now, setNow] = createSignal(Date.now());
	const tick = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
	onCleanup(() => clearInterval(tick));
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
					disabled={state.usageLoading}
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
