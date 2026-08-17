import { For, Show, createMemo, createSignal } from "solid-js";
import { api, type SessionStats } from "../api";
import { formatCompact, formatCost, formatDateTime, formatMs } from "../util/format";

interface AnalyticsProps {
	stats: () => SessionStats | undefined;
	error: () => Error | undefined;
	/** Clicking a tool row filters the transcript to that tool. */
	onPickTool: (name: string) => void;
	/** Called after a successful stats sync so health/sessions/analytics refetch. */
	onSynced: () => void;
}

export function AnalyticsView(props: AnalyticsProps) {
	const [syncPhase, setSyncPhase] = createSignal<"idle" | "syncing" | "done" | "error">("idle");
	const [syncMsg, setSyncMsg] = createSignal("");

	const runSync = async () => {
		if (syncPhase() === "syncing") return;
		setSyncPhase("syncing");
		try {
			const r = await api.sync();
			setSyncPhase("done");
			setSyncMsg(`Synced ${r.processed} entries from ${r.files} files`);
			props.onSynced();
		} catch (e) {
			setSyncPhase("error");
			setSyncMsg(e instanceof Error ? e.message : String(e));
		}
	};

	return (
		<div class="analytics">
			<header class="analytics-head">
				<button
					type="button"
					class="btn btn-small"
					disabled={syncPhase() === "syncing"}
					onClick={() => void runSync()}
					title="Run `omp stats --summary` on the server and refresh the stats.db index"
				>
					<Show when={syncPhase() === "syncing"} fallback="Sync stats DB">
						<span class="spin" aria-hidden="true" />
						Syncing…
					</Show>
				</button>
				<Show when={syncPhase() === "done"}>
					<span class="sync-status sync-ok" role="status">
						{syncMsg()}
					</span>
				</Show>
				<Show when={syncPhase() === "error"}>
					<span class="sync-status sync-error" role="alert">
						{syncMsg()}
						<button type="button" class="btn btn-small" onClick={() => setSyncPhase("idle")}>
							Dismiss
						</button>
					</span>
				</Show>
			</header>
			<Show
				when={props.error()}
				fallback={
					<Show when={props.stats()} fallback={<div class="hint">Loading analytics…</div>}>
						{(s) => <AnalyticsBody stats={s()} onPickTool={props.onPickTool} />}
					</Show>
				}
			>
				{(e) => <div class="tx-error-banner">Could not load analytics: {e().message}</div>}
			</Show>
		</div>
	);
}

/** Small provenance marker: "live" (fresh JSONL) vs "db" (stats.db) for unsynced sessions. */
function Prov(props: { src: "live" | "db" }) {
	return (
		<span
			class="prov"
			title={props.src === "live" ? "computed from the live session JSONL" : "from stats.db"}
		>
			{props.src}
		</span>
	);
}

function AnalyticsBody(props: { stats: SessionStats; onPickTool: (name: string) => void }) {
	const s = () => props.stats;

	/** Unsynced sessions mix fresh JSONL counts with empty stats.db columns — label the halves. */
	const unsynced = () => !s().synced;

	const maxTotalMs = createMemo(() => {
		const tools = s().tools;
		return Math.max(1, ...tools.map((t) => t.totalMs));
	});

	const longest = () => s().longestCall;
	const latency = () => s().latency;

	return (
		<>
			<Show when={unsynced()}>
				<div class="muted small prov-note">
					Not in stats.db — tool counts and durations are read live from the session JSONL (
					<span class="prov">live</span>); token, cost, and error figures come from stats.db (
					<span class="prov">db</span>) and stay empty until the session is synced.
				</div>
			</Show>
			<div class="cards">
				<div class="tx-card">
					<div class="label">
						Tool calls{" "}
						<Show when={unsynced()}>
							<Prov src="live" />
						</Show>
					</div>
					<div class="value">{formatCompact(s().toolCalls)}</div>
				</div>
				<div class="tx-card">
					<div class="label">
						Longest call{" "}
						<Show when={unsynced()}>
							<Prov src="live" />
						</Show>
					</div>
					<div
						class="value"
						title={longest() ? `${longest()!.toolName} · ${longest()!.toolCallId}` : undefined}
					>
						<Show when={longest()} fallback={<span class="value-muted">—</span>}>
							{(l) => (
								<span>
									{l().toolName} <span class="value-sub">{formatMs(l().durationMs)}</span>
								</span>
							)}
						</Show>
					</div>
				</div>
				<div class="tx-card">
					<div class="label">
						Session span{" "}
						<Show when={unsynced()}>
							<Prov src="live" />
						</Show>
					</div>
					<div class="value">{formatMs(s().spanMs)}</div>
				</div>
				<div class="tx-card">
					<div class="label">
						Tokens{" "}
						<Show when={unsynced()}>
							<Prov src="db" />
						</Show>
					</div>
					<div class="value">{formatCompact(s().totals.tokens)}</div>
				</div>
				<div class="tx-card">
					<div class="label">
						Cost{" "}
						<Show when={unsynced()}>
							<Prov src="db" />
						</Show>
					</div>
					<div class="value">{formatCost(s().totals.cost)}</div>
				</div>
				<div class="tx-card">
					<div class="label">
						Error turns{" "}
						<Show when={unsynced()}>
							<Prov src="db" />
						</Show>
					</div>
					<div classList={{ value: true, "value-err": s().errors.length > 0 }}>
						{s().errors.length}
					</div>
					<div class="value-note">capped at 100 in stats.db</div>
				</div>
			</div>

			<div class="panels">
				<section class="panel">
					<h3>
						Tool breakdown{" "}
						<Show when={unsynced()}>
							<Prov src="live" />
						</Show>
					</h3>
					<Show
						when={s().tools.length > 0}
						fallback={<div class="muted">No tool calls in this session.</div>}
					>
						<table class="tool-table">
							<thead>
								<tr>
									<th>tool</th>
									<th class="num">calls</th>
									<th class="num">errors</th>
									<th class="num">avg ms</th>
									<th class="num">total ms</th>
									<th class="num">args</th>
								</tr>
							</thead>
							<tbody>
								<For each={s().tools}>
									{(t) => (
										<>
											<tr
												class="tool-row"
												tabIndex={0}
												role="button"
												onClick={() => props.onPickTool(t.name)}
												onKeyDown={(e) => {
													if (e.key === "Enter" || e.key === " ") {
														e.preventDefault();
														props.onPickTool(t.name);
													}
												}}
												title="Click to filter transcript"
											>
												<td class="tx-tool-name">{t.name}</td>
												<td class="num">{t.calls}</td>
												<td classList={{ num: true, "num-err": t.errors > 0 }}>
													{t.errors > 0 ? t.errors : ""}
												</td>
												<td class="num">{formatMs(t.avgMs)}</td>
												<td class="num">{formatMs(t.totalMs)}</td>
												<td class="num">{formatCompact(t.argsChars)}</td>
											</tr>
											<tr class="bar-row">
												<td colspan={6}>
													<div
														class="bar"
														title={`total ${formatMs(t.totalMs)} · avg ${formatMs(t.avgMs)} · max ${formatMs(t.maxMs)} · ${t.pending} pending`}
													>
														<div
															class="bar-fill"
															style={{ width: `${Math.max(1, (t.totalMs / maxTotalMs()) * 100)}%` }}
														/>
													</div>
												</td>
											</tr>
										</>
									)}
								</For>
							</tbody>
						</table>
					</Show>
				</section>

				<section class="panel">
					<h3>
						Latency per turn{" "}
						<Show when={unsynced()}>
							<Prov src="db" />
						</Show>
					</h3>
					<div class="latency">
						<div class="latency-item">
							<span class="latency-label">p50</span>
							<span class="latency-value">{formatMs(latency().p50)}</span>
						</div>
						<div class="latency-item">
							<span class="latency-label">p90</span>
							<span class="latency-value">{formatMs(latency().p90)}</span>
						</div>
					</div>
					<div class="muted small">
						Tool durations are execution spans (tool start → result); calls without an
						execution-start marker show no duration.
					</div>
				</section>

				<section class="panel">
					<h3>Error turns</h3>
					<Show when={s().errors.length > 0} fallback={<div class="muted">No error turns.</div>}>
						<For each={s().errors}>
							{(e) => (
								<div class="error-turn">
									<span class="error-turn-ts">{formatDateTime(e.timestamp)}</span>
									<span class="error-turn-model">{e.model}</span>
									<span class="error-turn-msg">{e.message ?? "(no message)"}</span>
								</div>
							)}
						</For>
						<div class="muted small">Showing the latest 100 error turns stored in stats.db.</div>
					</Show>
				</section>
			</div>
		</>
	);
}
