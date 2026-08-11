/**
 * Aggregated daemons panel (Phase 4/5): the edge taps every daemon
 * connection — the connector's control socket and each proxy pipe — for
 * {type:"daemons"} broker rosters, caches the latest roster per daemonId
 * (full-replace, not union), and merges across daemons into the single
 * {type:"daemons"} frame browsers see.
 *
 * The client keys entries by `${projectDir}\u0000${name}` (ActiveDaemons);
 * daemon names are unique per projectDir and two ompds can share a
 * projectDir. When several daemons report the same key, the entry from the
 * daemon whose cwd equals the entry's projectDir wins (that ompd's broker
 * poll owns the directory), otherwise the latest arrival.
 */

import type { DaemonInfo } from "../src/protocol";

/** The browser's merge key (src/state.ts: `d.projectDir + "\u0000" + d.name`). */
export function daemonsKey(info: DaemonInfo): string {
	return `${info.projectDir}\u0000${info.name}`;
}

/** One daemon's cached roster plus arrival metadata (cwd = registry cwd). */
export interface DaemonRosterSource {
	cwd: string | undefined;
	/** Arrival timestamp in ms; later wins tie-breaks. */
	at: number;
	entries: DaemonInfo[];
}

/**
 * Merge per-daemon rosters into the single list the browser sees. Entries
 * with the same key collapse to one winner: the entry from the daemon whose
 * cwd equals the key's projectDir (latest among several such daemons), else
 * the latest arrival. Within one daemon's roster, later entries with the
 * same key replace earlier ones (mirrors the client's Map construction).
 */
export function mergeDaemonRosters(sources: ReadonlyMap<string, DaemonRosterSource>): DaemonInfo[] {
	const winners = new Map<string, { info: DaemonInfo; preferred: boolean; at: number }>();
	for (const source of sources.values()) {
		for (const info of source.entries) {
			const key = daemonsKey(info);
			const preferred = source.cwd === info.projectDir;
			const prev = winners.get(key);
			if (prev === undefined) {
				winners.set(key, { info, preferred, at: source.at });
			} else if (preferred && !prev.preferred) {
				// The reporting daemon owns this projectDir; it beats any
				// non-owner, no matter how recently the other arrived.
				winners.set(key, { info, preferred, at: source.at });
			} else if (preferred === prev.preferred && source.at >= prev.at) {
				winners.set(key, { info, preferred, at: source.at });
			}
		}
	}
	return [...winners.values()].map((w) => w.info);
}

/** Per-daemon roster cache with full-replace ingest and removal eviction. */
export class DaemonsAggregator {
	readonly #sources = new Map<string, DaemonRosterSource>();

	/** Replace daemonId's roster with the latest frame (full-replace). */
	ingest(daemonId: string, entries: DaemonInfo[], cwd: string | undefined, at: number = Date.now()): DaemonInfo[] {
		this.#sources.set(daemonId, { cwd, at, entries });
		return this.merge();
	}

	/** Evict a daemon (registry removal); returns the merged list without it. */
	remove(daemonId: string): DaemonInfo[] {
		this.#sources.delete(daemonId);
		return this.merge();
	}

	merge(): DaemonInfo[] {
		return mergeDaemonRosters(this.#sources);
	}
}
