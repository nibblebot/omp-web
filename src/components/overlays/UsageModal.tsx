import { For, onMount, Show, type Component } from "solid-js";
import type { UsageLimit } from "@oh-my-pi/pi-ai";
import { formatUnitAmount, resolveUsedFraction } from "../../usage/usage";
import { refreshUsageReports, state } from "../../state";
import { Modal } from "../shared/Modal";

/** One limit row: label, window, amount (used/limit + bar), status, notes. */
const LimitRow: Component<{ limit: UsageLimit }> = (props) => {
	const limit = () => props.limit;
	const w = () => limit().window;
	const pct = () => {
		const frac = resolveUsedFraction(limit());
		return frac === undefined ? undefined : Math.min(100, frac * 100);
	};
	return (
		<div class="usage-limit">
			<div class="usage-limit-head">
				<span class="picker-label">{limit().label}</span>
				{w()?.label && <span class="picker-detail">{w()!.label}</span>}
				{limit().status && limit().status !== "ok" && (
					<span class="usage-status" data-status={limit().status}>
						{limit().status}
					</span>
				)}
			</div>
			<Show when={pct() !== undefined}>
				<div class="amount-bar">
					<div class="amount-bar-fill" style={{ width: `${pct()!}%` }} />
				</div>
			</Show>
			<div class="usage-limit-amount">
				<span>{formatUnitAmount(limit().amount)}</span>
				{w()?.resetsAt !== undefined && (
					<span class="picker-detail">
						{w()?.resetLabel ?? "resets"} {new Date(w()!.resetsAt!).toLocaleString()}
					</span>
				)}
			</div>
			{limit().notes?.map((n) => (
				<div class="usage-note">{n}</div>
			))}
		</div>
	);
};

/**
 * Phase 9: /usage parity — per-provider limits with 5h/7d windows, utilization
 * bars, status and notes. Data comes from the READ_ONLY fetchUsageReports
 * relay row; providers without reporting resolve to the empty state.
 */
export const UsageModal: Component<{ onClose: () => void }> = (props) => {
	onMount(() => refreshUsageReports());

	return (
		<Modal title="Usage reports" onClose={props.onClose}>
			<Show when={state.usageLoading}>
				<span class="usage-empty">Loading usage reports…</span>
			</Show>
			<Show when={!state.usageLoading && state.usageError !== null}>
				<div class="usage-empty">Failed to load usage: {state.usageError}</div>
			</Show>
			<Show
				when={
					!state.usageLoading &&
					state.usageError === null &&
					(state.usageReports?.length ?? 0) === 0
				}
			>
				<div class="usage-empty">No usage reporting for the active provider.</div>
			</Show>
			<Show
				when={
					!state.usageLoading && state.usageError === null && (state.usageReports?.length ?? 0) > 0
				}
			>
				<div class="usage-list">
					<For each={state.usageReports}>
						{(report) => (
							<section class="usage-provider">
								<h3 class="stats-subhead">
									{report.provider}
									<span class="picker-detail">
										{" "}
										fetched {new Date(report.fetchedAt).toLocaleString()}
									</span>
								</h3>
								{report.notes?.map((n) => (
									<div class="usage-note">{n}</div>
								))}
								<For each={report.limits}>{(limit) => <LimitRow limit={limit} />}</For>
							</section>
						)}
					</For>
				</div>
			</Show>
		</Modal>
	);
};
