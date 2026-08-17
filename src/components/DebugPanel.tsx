import {
	createEffect,
	createSignal,
	For,
	onCleanup,
	onMount,
	Show,
	type Component,
} from "solid-js";
import { clientId, state } from "../state";
import { formatDaemonUptime } from "./ActiveDaemons";
import { Modal } from "./Modal";

// ---------------------------------------------------------------------------
// Debug panel: an engineer's view of BOTH halves of the connection loop —
// the browser transport (state.ts ring) and the fleet control plane
// (GET /ctl/debug through vite's /ctl proxy → 127.0.0.1:4722). In
// single-session mode (or while the fleet boots) the /ctl fetch fails with a
// connection refused; that is the EXPECTED state and renders as a notice, not
// a crash. Tolerant parsing: unknown/absent fields degrade to "—" instead of
// throwing on a half-landed payload.
// ---------------------------------------------------------------------------

// --- Fleet payload types (mirror of the /ctl/debug contract; tolerant) ---

type FleetLevel = "info" | "warn" | "error";

type FleetLogEntry = {
	ts: number;
	level: FleetLevel;
	source: string;
	message: string;
	daemonId?: string;
};

type FleetConnector = {
	state: string;
	attempts: number;
	nextRetryInMs?: number;
};

type FleetSession = {
	daemonId?: string;
	name?: string;
	status?: string;
	mode?: string;
	endpoint?: string;
	pid?: number;
	readyAt?: number;
	registeredAt?: number;
	uptimeSec?: number;
	error?: string;
	connector?: FleetConnector;
};

type FleetDebug = {
	fleet?: {
		port?: number;
		startedAt?: number;
		uptimeSec?: number;
		statePath?: string;
		configPath?: string | null;
	};
	// normalizeFleet always supplies these (absent payload fields → []).
	sessions: FleetSession[];
	log: FleetLogEntry[];
};

function asRecord(v: unknown): Record<string, unknown> | undefined {
	return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

function asString(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Extract only the contract's fields, tolerantly; unknown fields are dropped. */
function normalizeFleet(raw: unknown): FleetDebug | null {
	const root = asRecord(raw);
	if (!root) return null;
	const fleetRec = asRecord(root.fleet);
	const sessions: FleetSession[] = [];
	if (Array.isArray(root.sessions)) {
		for (const s of root.sessions) {
			const r = asRecord(s);
			if (!r) continue;
			const connector = asRecord(r.connector);
			sessions.push({
				daemonId: asString(r.daemonId),
				name: asString(r.name),
				status: asString(r.status),
				mode: asString(r.mode),
				endpoint: asString(r.endpoint),
				pid: asNumber(r.pid),
				readyAt: asNumber(r.readyAt),
				registeredAt: asNumber(r.registeredAt),
				uptimeSec: asNumber(r.uptimeSec),
				error: asString(r.error),
				...(connector !== undefined
					? {
							connector: {
								state: asString(connector.state) ?? "unknown",
								attempts: asNumber(connector.attempts) ?? 0,
								nextRetryInMs: asNumber(connector.nextRetryInMs),
							},
						}
					: {}),
			});
		}
	}
	const log: FleetLogEntry[] = [];
	if (Array.isArray(root.log)) {
		for (const l of root.log) {
			const r = asRecord(l);
			if (!r) continue;
			const level = asString(r.level);
			if (level !== "info" && level !== "warn" && level !== "error") continue;
			const message = asString(r.message);
			if (message === undefined) continue;
			const daemonId = asString(r.daemonId);
			log.push({
				ts: asNumber(r.ts) ?? 0,
				level,
				source: asString(r.source) ?? "fleet",
				message,
				...(daemonId !== undefined ? { daemonId } : {}),
			});
		}
	}
	return {
		...(fleetRec !== undefined
			? {
					fleet: {
						port: asNumber(fleetRec.port),
						startedAt: asNumber(fleetRec.startedAt),
						uptimeSec: asNumber(fleetRec.uptimeSec),
						statePath: asString(fleetRec.statePath),
						configPath: asString(fleetRec.configPath) ?? null,
					},
				}
			: {}),
		sessions,
		log,
	};
}

/** HH:MM:SS local wall time for a ms-epoch timestamp (log rows, startedAt). */
function fmtTime(ts: number): string {
	return ts > 0 ? new Date(ts).toTimeString().slice(0, 8) : "—";
}

/** Host[:port] of a ws/http endpoint URL; the raw string when unparsable. */
function endpointHost(endpoint: string): string {
	try {
		return new URL(endpoint).host;
	} catch {
		return endpoint;
	}
}

/** Shared ring renderer for both logs: level-colored tag + source + message,
 *  newest entry last, stick-to-bottom while the reader is already at the tail. */
const LogRing: Component<{
	entries: () => Array<{
		ts: number;
		level: string;
		source: string;
		message: string;
		daemonId?: string;
	}>;
	empty: string;
}> = (props) => {
	const [stick, setStick] = createSignal(true);
	let box!: HTMLDivElement;
	const onScroll = () => {
		const el = box;
		setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
	};
	createEffect(() => {
		void props.entries().length; // re-run when the ring grows
		if (stick()) box?.scrollTo({ top: box.scrollHeight });
	});
	return (
		<div class="debug-log" ref={box} onScroll={onScroll}>
			<Show when={props.entries().length === 0}>
				<div class="debug-log-empty">{props.empty}</div>
			</Show>
			<For each={props.entries()}>
				{(e) => (
					<div class="debug-log-line" data-level={e.level}>
						<span class="debug-log-time">{fmtTime(e.ts)}</span>
						<span class="debug-log-level">{e.level}</span>
						<span class="debug-log-source">
							{e.source}
							{e.daemonId !== undefined ? `/${e.daemonId.slice(0, 8)}` : ""}
						</span>
						<span class="debug-log-msg" title={e.message}>
							{e.message}
						</span>
					</div>
				)}
			</For>
		</div>
	);
};

export const DebugPanel: Component<{ onClose: () => void }> = (props) => {
	const [fleet, setFleet] = createSignal<FleetDebug | null>(null);
	const [fleetError, setFleetError] = createSignal<string | null>(null);
	const [fleetLoading, setFleetLoading] = createSignal(false);
	const [now, setNow] = createSignal(Date.now());
	// Overlapping-poll guard: the loopback fetch is fast, but a stalled proxy
	// must not stack requests every 2s.
	let fleetPolling = false;

	const loadFleet = () => {
		if (fleetPolling) return;
		fleetPolling = true;
		setFleetLoading(true);
		fetch("/ctl/debug")
			.then((r) => {
				if (!r.ok) {
					// 502/504: vite's /ctl proxy couldn't reach :4722 — no fleet
					// server (single-session mode, or still booting). Expected.
					throw new Error(
						r.status === 502 || r.status === 504
							? "fleet control plane unreachable — no fleet server on :4722"
							: `fleet control plane unreachable (HTTP ${r.status})`,
					);
				}
				return r.json() as Promise<unknown>;
			})
			.then((raw) => {
				const data = normalizeFleet(raw);
				if (data === null) throw new Error("fleet control plane answered malformed JSON");
				setFleet(data);
				setFleetError(null);
			})
			.catch((err) => {
				const msg = err instanceof Error ? err.message : String(err);
				// fetch() rejects with a TypeError when nothing listens on
				// :4722 (single-session mode, fleet not yet up). Expected.
				setFleetError(
					/failed to fetch|networkerror|fetch failed/i.test(msg)
						? "fleet control plane unreachable — no fleet server on :4722"
						: msg,
				);
			})
			.finally(() => {
				fleetPolling = false;
				setFleetLoading(false);
			});
	};

	// Fetch on open, then auto-poll ~2s while the panel stays open (DaemonDetail
	// fetch+refresh pattern, plus the poll so a booting fleet appears live).
	onMount(() => {
		void loadFleet();
		const poll = setInterval(() => void loadFleet(), 2000);
		setNow(Date.now());
		const tick = setInterval(() => setNow(Date.now()), 1000);
		onCleanup(() => {
			clearInterval(poll);
			clearInterval(tick);
		});
	});

	const secondsSinceLastFrame = () => {
		if (state.lastFrameAt <= 0) return null;
		return Math.max(0, Math.round((now() - state.lastFrameAt) / 1000));
	};

	return (
		<Modal title="Debug" variant="sheet" class="debug-panel" onClose={props.onClose}>
			<div class="debug-scroll">
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
							<span class="debug-label">mode</span>
							<span class="debug-value">{state.sessionMode}</span>
						</div>
						<div class="debug-fact">
							<span class="debug-label">session</span>
							<span class="debug-value" title={state.currentSessionId}>
								{state.currentSessionId === "" ? "—" : state.currentSessionId.slice(0, 8)}
							</span>
						</div>
						<div class="debug-fact">
							<span class="debug-label">client</span>
							<span class="debug-value" title={clientId}>
								{clientId.slice(0, 8)}
							</span>
						</div>
						<div class="debug-fact">
							<span class="debug-label">last frame</span>
							<span class="debug-value">
								{secondsSinceLastFrame() === null ? "never" : `${secondsSinceLastFrame()}s ago`}
							</span>
						</div>
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
											<span class="debug-value">{fl()?.port ?? "—"}</span>
										</div>
										<div class="debug-fact">
											<span class="debug-label">uptime</span>
											<span class="debug-value">
												{fl()?.uptimeSec !== undefined
													? formatDaemonUptime(fl()!.uptimeSec! * 1000)
													: "—"}
											</span>
										</div>
										<div class="debug-fact">
											<span class="debug-label">since</span>
											<span class="debug-value">
												{fl()?.startedAt !== undefined ? fmtTime(fl()!.startedAt!) : "—"}
											</span>
										</div>
										<div class="debug-fact">
											<span class="debug-label">state</span>
											<span class="debug-value" title={fl()?.statePath ?? ""}>
												{fl()?.statePath ?? "—"}
											</span>
										</div>
										<div class="debug-fact">
											<span class="debug-label">config</span>
											<span class="debug-value" title={fl()?.configPath ?? ""}>
												{fl()?.configPath ?? "—"}
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
														<th>endpoint</th>
														<th>uptime</th>
														<th>connector</th>
													</tr>
												</thead>
												<tbody>
													<For each={f().sessions}>
														{(s) => (
															<tr>
																<td class="debug-cell-name" title={s.daemonId}>
																	{s.name ?? s.daemonId?.slice(0, 8) ?? "—"}
																</td>
																<td>
																	<span
																		class="debug-status"
																		data-status={s.status ?? "unknown"}
																		title={s.error ?? s.status ?? ""}
																	>
																		{s.status ?? "—"}
																	</span>
																</td>
																<td>{s.mode ?? "—"}</td>
																<td>{s.pid ?? "—"}</td>
																<td class="debug-cell-mono" title={s.endpoint}>
																	{s.endpoint !== undefined ? endpointHost(s.endpoint) : "—"}
																</td>
																<td>
																	{s.uptimeSec !== undefined
																		? formatDaemonUptime(s.uptimeSec * 1000)
																		: "—"}
																</td>
																<td class="debug-cell-mono">
																	{s.connector
																		? `${s.connector.state}${s.connector.attempts > 0 ? ` (${s.connector.attempts})` : ""}${
																				s.connector.nextRetryInMs !== undefined
																					? ` · ${s.connector.nextRetryInMs}ms`
																					: ""
																			}`
																		: "—"}
																</td>
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
					<LogRing
						entries={() => fleet()?.log ?? []}
						empty="no fleet log — control plane unreachable"
					/>
				</section>

				<section class="debug-section">
					<div class="debug-section-head">
						<h3 class="debug-section-title">Client transport</h3>
						<span class="debug-poll-hint">{state.debugLog.length} entries</span>
					</div>
					<LogRing entries={() => state.debugLog} empty="no transport events yet" />
				</section>
			</div>
		</Modal>
	);
};
