import { fetchCtlDebug } from "../state";

// ---------------------------------------------------------------------------
// Fleet debug contract: tolerant parsing of the /ctl/debug payload (mirror of
// the fleet control-plane contract). Unknown/absent fields degrade to "—"
// instead of throwing on a half-landed payload. Pure logic — no JSX. The
// fetch itself goes through the shared fetchCtlDebug() state action, which
// owns the unreachable/HTTP error vocabulary (single-session mode renders as
// a notice, not a crash).
// ---------------------------------------------------------------------------

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

export type FleetDebug = {
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
export function fmtTime(ts: number): string {
	return ts > 0 ? new Date(ts).toTimeString().slice(0, 8) : "—";
}

/** Host[:port] of a ws/http endpoint URL; the raw string when unparsable. */
export function endpointHost(endpoint: string): string {
	try {
		return new URL(endpoint).host;
	} catch {
		return endpoint;
	}
}

/** GET /ctl/debug via the shared fetchCtlDebug() state action, normalized to
 *  the tolerant FleetDebug shape. Rejects with the action's unreachable/HTTP
 *  vocabulary, or "fleet control plane answered malformed JSON" when the
 *  payload is not a JSON object. */
export async function fetchFleetDebug(): Promise<FleetDebug> {
	const raw = await fetchCtlDebug();
	const data = normalizeFleet(raw);
	if (data === null) throw new Error("fleet control plane answered malformed JSON");
	return data;
}
