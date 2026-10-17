import { For, Show, createMemo, createResource, createSignal } from "solid-js";
import { api, type Health, type StatsRollup } from "../../store/fleet-api";
import { formatCompact, formatCost, timeAgo } from "../util/format";

const RANGES = [7, 30, 90] as const;

interface SpendPanelProps {
	health: () => Health | null | undefined;
	/** bumped after a stats sync so the rollup refetches */
	syncTick: () => number;
}

/** Aggregate spend overview shown when no session is selected: KPIs, daily cost, models, tools, projects. */
export function SpendPanel(props: SpendPanelProps) {
	const [days, setDays] = createSignal<number>(30);
	const [rollup] = createResource(
		() => ({ days: days(), tick: props.syncTick() }),
		(k) => api.rollup(k.days, -new Date().getTimezoneOffset()),
	);
	const data = (): StatsRollup | undefined => (rollup.error ? undefined : rollup());
	const maxCost = createMemo(() => Math.max(0, ...(data()?.buckets.map((b) => b.cost) ?? [])));
	const syncedMs = () => {
		const iso = props.health()?.lastSyncedAt;
		return iso ? Date.parse(iso) : null;
	};

	return (
		<section class="spend-panel" aria-labelledby="spend-title">
			<header class="spend-head">
				<h2 id="spend-title">Spend overview</h2>
				<div class="spend-range" role="group" aria-label="Date range">
					<For each={RANGES}>
						{(d) => (
							<button
								type="button"
								class="btn"
								classList={{ active: days() === d }}
								aria-pressed={days() === d}
								onClick={() => setDays(d)}
							>
								{d} days
							</button>
						)}
					</For>
				</div>
			</header>
			<Show
				when={data()}
				keyed
				fallback={
					<p class="spend-status">
						{rollup.error
							? "Spend overview unavailable: stats.db is missing or unreadable. Run a sync and try again."
							: "Loading spend…"}
					</p>
				}
			>
				{(d) => (
					<>
						<dl class="spend-kpis">
							<div class="spend-kpi">
								<dt>Sessions</dt>
								<dd>{formatCompact(d.totals.sessions)}</dd>
							</div>
							<div class="spend-kpi">
								<dt>Turns</dt>
								<dd>{formatCompact(d.totals.turns)}</dd>
							</div>
							<div class="spend-kpi">
								<dt>Tokens</dt>
								<dd>{formatCompact(d.totals.tokens)}</dd>
							</div>
							<div class="spend-kpi">
								<dt>Cost</dt>
								<dd>{formatCost(d.totals.cost)}</dd>
							</div>
							<div class="spend-kpi">
								<dt>Tool calls</dt>
								<dd>{formatCompact(d.totals.toolCalls)}</dd>
							</div>
							<div class="spend-kpi">
								<dt>Errors</dt>
								<dd>{formatCompact(d.totals.errors)}</dd>
							</div>
						</dl>

						<h3>Daily cost</h3>
						<div class="spend-bars" role="img" aria-label={`Daily cost, last ${d.days} days`}>
							<For each={d.buckets}>
								{(b) => (
									<div
										class="spend-bar"
										title={`${new Date(b.ts).toLocaleDateString()}: ${formatCost(b.cost)} · ${formatCompact(b.turns)} turns`}
									>
										<span
											style={{
												height: `${maxCost() > 0 ? (b.cost / maxCost()) * 100 : 0}%`,
											}}
										/>
									</div>
								)}
							</For>
						</div>

						<div class="spend-tables">
							<div>
								<h3>Models</h3>
								<Show
									when={d.models.length > 0}
									fallback={<p class="spend-status">No model usage in this window.</p>}
								>
									<table class="spend-table">
										<thead>
											<tr>
												<th scope="col">Model</th>
												<th scope="col">Turns</th>
												<th scope="col">Tokens</th>
												<th scope="col">Cost</th>
												<th scope="col">Errors</th>
											</tr>
										</thead>
										<tbody>
											<For each={d.models}>
												{(m) => (
													<tr>
														<td title={m.provider}>{m.model}</td>
														<td>{formatCompact(m.turns)}</td>
														<td>{formatCompact(m.tokens)}</td>
														<td>{formatCost(m.cost)}</td>
														<td>{formatCompact(m.errors)}</td>
													</tr>
												)}
											</For>
										</tbody>
									</table>
								</Show>
							</div>
							<div>
								<h3>Tools</h3>
								<Show
									when={d.tools.length > 0}
									fallback={<p class="spend-status">No tool calls in this window.</p>}
								>
									<table class="spend-table">
										<thead>
											<tr>
												<th scope="col">Tool</th>
												<th scope="col">Calls</th>
												<th scope="col">Errors</th>
											</tr>
										</thead>
										<tbody>
											<For each={d.tools}>
												{(t) => (
													<tr>
														<td>{t.name}</td>
														<td>{formatCompact(t.calls)}</td>
														<td>{formatCompact(t.errors)}</td>
													</tr>
												)}
											</For>
										</tbody>
									</table>
								</Show>
							</div>
							<div>
								<h3>Projects</h3>
								<Show
									when={d.projects.length > 0}
									fallback={<p class="spend-status">No projects in this window.</p>}
								>
									<table class="spend-table">
										<thead>
											<tr>
												<th scope="col">Project</th>
												<th scope="col">Sessions</th>
												<th scope="col">Tokens</th>
												<th scope="col">Cost</th>
											</tr>
										</thead>
										<tbody>
											<For each={d.projects}>
												{(p) => (
													<tr>
														<td>{p.folder}</td>
														<td>{formatCompact(p.sessions)}</td>
														<td>{formatCompact(p.tokens)}</td>
														<td>{formatCost(p.cost)}</td>
													</tr>
												)}
											</For>
										</tbody>
									</table>
								</Show>
							</div>
						</div>
					</>
				)}
			</Show>
			<p class="spend-foot">
				Figures come from stats.db.{" "}
				<Show when={syncedMs() !== null} fallback={<>Not synced yet; run a sync.</>}>
					Last synced {timeAgo(syncedMs())}.
				</Show>
			</p>
		</section>
	);
}
