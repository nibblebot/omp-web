import { createSignal, For, onMount, Show, type Component } from "solid-js";
import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import { formatUnitAmount } from "../usage";
import { call, setState } from "../state";
import { Modal } from "./Modal";

/**
 * Fraction of a limit used (0..1), or undefined when the report gives no
 * usable ratio. Local copy of pi-ai's resolveUsedFraction — a runtime value
 * import from @oh-my-pi/pi-ai pulls the package's non-JS assets into the
 * vite dep graph and breaks the optimizer (documented plan constraint:
 * type-only imports only).
 */
export function resolveUsedFraction(limit: UsageLimit): number | undefined {
	const a = limit.amount;
	if (typeof a.usedFraction === "number" && Number.isFinite(a.usedFraction)) return a.usedFraction;
	if (typeof a.used === "number" && typeof a.limit === "number" && a.limit > 0)
		return a.used / a.limit;
	if (typeof a.remainingFraction === "number" && Number.isFinite(a.remainingFraction))
		return 1 - a.remainingFraction;
	if (typeof a.remaining === "number" && typeof a.limit === "number" && a.limit > 0)
		return 1 - a.remaining / a.limit;
	return undefined;
}

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
export const UsagePanel: Component<{ onClose: () => void }> = (props) => {
	const [reports, setReports] = createSignal<UsageReport[] | null>(null);
	const [loading, setLoading] = createSignal(true);
	const [error, setError] = createSignal<string | null>(null);

	onMount(() => {
		void call("fetchUsageReports")
			.then((result) => {
				setReports((result as UsageReport[] | null) ?? []);
				setLoading(false);
			})
			.catch((err) => {
				setError(String(err));
				setLoading(false);
			});
	});

	return (
		<Modal title="Usage reports" onClose={props.onClose}>
			<Show when={loading()}>
				<span class="usage-empty">Loading usage reports…</span>
			</Show>
			<Show when={!loading() && error() !== null}>
				<div class="usage-empty">Failed to load usage: {error()}</div>
			</Show>
			<Show when={!loading() && error() === null && (reports()?.length ?? 0) === 0}>
				<div class="usage-empty">No usage reporting for the active provider.</div>
			</Show>
			<Show when={!loading() && error() === null && (reports()?.length ?? 0) > 0}>
				<div class="usage-list">
					<For each={reports()}>
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
