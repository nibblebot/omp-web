import { createSignal, For, onMount, Show, type Component } from "solid-js";
import { buildInfo } from "../../../build-info";
import { createVisibleInterval } from "../../../page-visibility";
import { clientId, state } from "../../../state";
import { fetchFleetDebug, fmtPair, fmtTime, type FleetDebug } from "../../../fleet-ui/fleet-debug";
import { formatUptime } from "../../../text/uptime";
import { Modal } from "../../ui/Modal";
import { OmpLogoIcon } from "../../ui/icons";
import { LastFrameClock } from "./LastFrameClock";
import { DebugLog } from "./DebugLog";

// ---------------------------------------------------------------------------
// Debug panel: an engineer's view of BOTH halves of the connection loop:
// the browser transport (state.ts ring) and the fleet control plane
// (GET /ctl/debug via the fetchFleetDebug state action → vite's /ctl proxy →
// 127.0.0.1:4722). The /ctl fetch fails while the fleet boots or is
// unreachable; that is the EXPECTED state and renders as a notice, not a
// crash. Tolerant parsing: unknown/absent fields degrade to a dash
// placeholder instead of throwing on a half-landed payload.
// ---------------------------------------------------------------------------

export const FleetDebugSheet: Component<{ onClose: () => void }> = (props) => {
	const [fleet, setFleet] = createSignal<FleetDebug | null>(null);
	const [fleetError, setFleetError] = createSignal<string | null>(null);
	const [fleetLoading, setFleetLoading] = createSignal(false);
	// Overlapping-poll guard: the loopback fetch is fast, but a stalled proxy
	// must not stack requests every 2s.
	let fleetPolling = false;

	const loadFleet = () => {
		if (fleetPolling) return;
		fleetPolling = true;
		setFleetLoading(true);
		fetchFleetDebug()
			.then((data) => {
				setFleet(data);
				setFleetError(null);
			})
			.catch((err) => {
				setFleetError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				fleetPolling = false;
				setFleetLoading(false);
			});
	};

	// Fetch on open, then auto-poll ~2s while the panel stays open (SessionDetail
	// fetch+refresh pattern, plus the poll so a booting fleet appears live).
	// The 1s clock tick lives in LastFrameClock, scoped so it re-renders only
	// the "last frame" readout.
	onMount(() => {
		void loadFleet();
		createVisibleInterval(() => void loadFleet(), 2000);
	});

	return (
		<Modal title="Debug" variant="sheet" class="debug-sheet" onClose={props.onClose}>
			<div class="debug-scroll">
				<section class="debug-section debug-build">
					<h3 class="debug-section-title">Build</h3>
					<div class="debug-facts">
						<div class="debug-fact">
							<span class="debug-label">omp-web</span>
							<span class="debug-value" title="omp-web version and commit">
								{buildInfo.version && `v${buildInfo.version}`}
								{buildInfo.version && buildInfo.gitHash && " · "}
								{buildInfo.gitHash}
							</span>
						</div>
						<Show when={buildInfo.ompVersion}>
							<div class="debug-fact">
								<span class="debug-label">
									<OmpLogoIcon class="debug-build-logo" /> omp
								</span>
								<span class="debug-value" title="Upstream omp version">
									v{buildInfo.ompVersion}
								</span>
							</div>
						</Show>
					</div>
				</section>
				<section class="debug-section">
					<h3 class="debug-section-title">Connection</h3>
					<div class="debug-facts">
						<div class="debug-fact">
							<span class="debug-label">state</span>
							<span class="debug-pill" data-status={state.connected ? "connected" : "disconnected"}>
								{state.connected ? "connected" : "disconnected"}
							</span>
						</div>
						<div class="debug-fact">
							<span class="debug-label">session</span>
							<span class="debug-value" title={state.currentWorkspaceId}>
								{state.currentWorkspaceId === "" ? "-" : state.currentWorkspaceId.slice(0, 8)}
							</span>
						</div>
						<div class="debug-fact">
							<span class="debug-label">client</span>
							<span class="debug-value" title={clientId}>
								{clientId.slice(0, 8)}
							</span>
						</div>
						<LastFrameClock />
						<div class="debug-fact">
							<span class="debug-label">reconnect</span>
							<span class="debug-value">
								{state.reconnectDelay > 0 ? `${state.reconnectDelay}ms` : "none (stream open)"}
							</span>
						</div>
					</div>
				</section>

				<section class="debug-section">
					<div class="debug-section-head">
						<h3 class="debug-section-title">Fleet</h3>
						<span class="debug-poll-hint">{fleetLoading() ? "polling…" : "polls every 2s"}</span>
						<button
							type="button"
							class="debug-refresh"
							disabled={fleetLoading()}
							onClick={() => void loadFleet()}
						>
							refresh
						</button>
					</div>
					<Show when={fleetError()}>{(err) => <div class="debug-fleet-error">{err()}</div>}</Show>
					<Show when={fleet()}>
						{(f) => {
							const fl = () => f().fleet;
							return (
								<>
									<div class="debug-facts">
										<div class="debug-fact">
											<span class="debug-label">port</span>
											<span class="debug-value">{fl()?.port ?? "-"}</span>
										</div>
										<div class="debug-fact">
											<span class="debug-label">uptime</span>
											<span class="debug-value">
												{fl()?.uptimeSec !== undefined
													? formatUptime(fl()!.uptimeSec! * 1000)
													: "-"}
											</span>
										</div>
										<div class="debug-fact">
											<span class="debug-label">since</span>
											<span class="debug-value">
												{fl()?.startedAt !== undefined ? fmtTime(fl()!.startedAt!) : "-"}
											</span>
										</div>
										<div class="debug-fact">
											<span class="debug-label">state</span>
											<span class="debug-value" title={fl()?.statePath ?? ""}>
												{fl()?.statePath ?? "-"}
											</span>
										</div>
										<div class="debug-fact">
											<span class="debug-label">config</span>
											<span class="debug-value" title={fl()?.configPath ?? ""}>
												{fl()?.configPath ?? "-"}
											</span>
										</div>
									</div>
									<Show when={f().sessions.length > 0}>
										<div class="debug-table-wrap">
											<table class="debug-table">
												<thead>
													<tr>
														<th>name</th>
														<th>status</th>
														<th>mode</th>
														<th>pid</th>
														<th>uptime</th>
														<th>pair</th>
													</tr>
												</thead>
												<tbody>
													<For each={f().sessions}>
														{(s) => (
															<tr>
																<td class="debug-cell-name" title={s.workspaceId}>
																	{s.name ?? s.workspaceId?.slice(0, 8) ?? "-"}
																</td>
																<td>
																	<span
																		class="debug-status"
																		data-status={s.status ?? "unknown"}
																		title={s.error ?? s.status ?? ""}
																	>
																		{s.status ?? "-"}
																	</span>
																</td>
																<td>{s.mode ?? "-"}</td>
																<td>{s.pid ?? "-"}</td>
																<td>
																	{s.uptimeSec !== undefined
																		? formatUptime(s.uptimeSec * 1000)
																		: "-"}
																</td>
																<td class="debug-cell-mono">{s.pair ? fmtPair(s.pair) : "-"}</td>
															</tr>
														)}
													</For>
												</tbody>
											</table>
										</div>
									</Show>
									<Show when={f().sessions.length === 0}>
										<div class="debug-log-empty">no sessions</div>
									</Show>
								</>
							);
						}}
					</Show>
					<Show when={!fleet() && fleetError() === null}>
						<div class="debug-log-empty">fetching /ctl/debug…</div>
					</Show>
				</section>

				<section class="debug-section">
					<h3 class="debug-section-title">Fleet log</h3>
					<DebugLog
						entries={() => fleet()?.log ?? []}
						empty="no fleet log, control plane unreachable"
					/>
				</section>

				<section class="debug-section">
					<div class="debug-section-head">
						<h3 class="debug-section-title">Client transport</h3>
						<span class="debug-poll-hint">{state.debugLog.length} entries</span>
					</div>
					<DebugLog entries={() => state.debugLog} empty="no transport events yet" />
				</section>
			</div>
		</Modal>
	);
};
