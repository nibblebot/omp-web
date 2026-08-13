/**
 * FleetEventLog: the fleet's capped lifecycle-event ring.
 *
 * Every meaningful fleet transition — daemon status changes, spawn/exit/
 * respawn, control-route failures — is appended here so /ctl/debug and the
 * serve-mode CLI can show what the fleet has been doing. The ring is capped
 * (default 500 entries; the oldest fall off) and MUST never hold secrets:
 * callers strip bearer tokens before logging.
 *
 * The optional onEntry mirror lets a consumer render entries as they are
 * added (the CLI prints one `fleet:` line per event) without polling.
 */

export type FleetLogLevel = "info" | "warn" | "error";

export interface FleetLogEntry {
	/** Epoch milliseconds when the event happened. */
	ts: number;
	level: FleetLogLevel;
	/** The emitting subsystem: "connector", "supervisor", "server", … */
	source: string;
	message: string;
	/** The daemon the event concerns, when daemon-scoped. */
	daemonId?: string;
}

/** Fleet-wide facts surfaced by /ctl/debug and the serve startup banner. */
export interface FleetFacts {
	port: number;
	/** Epoch milliseconds of fleet start (process boot, not first request). */
	startedAt: number;
	/** Resolved registry state path (the file the fleet persists to). */
	statePath: string;
	/** Resolved config path, or null when no config file exists (defaults). */
	configPath: string | null;
}

const DEFAULT_CAP = 500;

export class FleetEventLog {
	#entries: FleetLogEntry[] = [];
	#cap: number;
	/** Mirror fired for every added entry (CLI human lines); never awaited. */
	onEntry: ((entry: FleetLogEntry) => void) | null = null;

	constructor(cap: number = DEFAULT_CAP) {
		this.#cap = cap;
	}

	/** Append one entry (dropping the oldest past the cap) and mirror it. */
	add(level: FleetLogLevel, source: string, message: string, daemonId?: string): FleetLogEntry {
		const entry: FleetLogEntry = { ts: Date.now(), level, source, message };
		if (daemonId !== undefined) entry.daemonId = daemonId;
		this.#entries.push(entry);
		if (this.#entries.length > this.#cap) {
			this.#entries.splice(0, this.#entries.length - this.#cap);
		}
		this.onEntry?.(entry);
		return entry;
	}

	/** A copy of the ring, oldest first. */
	list(): FleetLogEntry[] {
		return [...this.#entries];
	}
}
