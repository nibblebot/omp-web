/**
 * Aggregated daemons panel (Phase 4/5): the edge taps every session's
 * callback pair for {type:"daemons"} broker rosters, both its control-stream
 * envelopes and each browser's callback stream. It caches the latest roster per
 * workspaceId (full-replace, not union) and merges it across sessions into the
 * single {type:"daemons"} frame browsers see.
 *
 * The client keys entries by daemonsKey (lib/wire/protocol.ts:
 * `${projectDir}\u0000${name}`); daemon names are unique per projectDir and
 * two omp-sessions can share a projectDir. When several sessions report the
 * same key, the entry from the session whose cwd equals the entry's projectDir
 * wins (that omp-session's broker poll owns the directory), otherwise the
 * latest arrival. Every merged entry carries `reportedBy`, the workspaceIds whose
 * broker roster listed the key, so the browser can scope the strip to the
 * selected session's workspace without comparing host and in-sandbox paths.
 */

import { daemonsKey, type DaemonInfo } from "#lib/wire/protocol";

export { daemonsKey };

/** One session's cached roster plus arrival metadata (cwd = registry cwd). */
export interface DaemonRosterSource {
	cwd: string | undefined;
	/** Arrival timestamp in ms; later wins tie-breaks. */
	at: number;
	entries: DaemonInfo[];
}

/**
 * Merge per-session rosters into the single list the browser sees. Entries
 * with the same key collapse to one winner: the entry from the session whose
 * cwd equals the key's projectDir (latest among several such sessions), else
 * the latest arrival. Within one session's roster, later entries with the
 * same key replace earlier ones (mirrors the client's Map construction).
 * The winner is stamped with `reportedBy`: every workspaceId that listed the key.
 */
export function mergeDaemonRosters(sources: ReadonlyMap<string, DaemonRosterSource>): DaemonInfo[] {
	const winners = new Map<
		string,
		{ info: DaemonInfo; preferred: boolean; at: number; reportedBy: Set<string> }
	>();
	for (const [workspaceId, source] of sources) {
		for (const info of source.entries) {
			const key = daemonsKey(info);
			const preferred = source.cwd === info.projectDir;
			const prev = winners.get(key);
			if (prev === undefined) {
				winners.set(key, { info, preferred, at: source.at, reportedBy: new Set([workspaceId]) });
				continue;
			}
			prev.reportedBy.add(workspaceId);
			// The reporting session owns this projectDir; it beats any
			// non-owner, no matter how recently the other arrived.
			if (
				(preferred && !prev.preferred) ||
				(preferred === prev.preferred && source.at >= prev.at)
			) {
				prev.info = info;
				prev.preferred = preferred;
				prev.at = source.at;
			}
		}
	}
	return [...winners.values()].map((w) => ({ ...w.info, reportedBy: [...w.reportedBy] }));
}

/** Per-session roster cache with full-replace ingest and removal eviction. */
export class DaemonsAggregator {
	readonly #sources = new Map<string, DaemonRosterSource>();

	/** Replace workspaceId's roster with the latest frame (full-replace). */
	ingest(
		workspaceId: string,
		entries: DaemonInfo[],
		cwd: string | undefined,
		at: number = Date.now(),
	): DaemonInfo[] {
		this.#sources.set(workspaceId, { cwd, at, entries });
		return this.merge();
	}

	/** Evict a session (registry removal); returns the merged list without it. */
	remove(workspaceId: string): DaemonInfo[] {
		this.#sources.delete(workspaceId);
		return this.merge();
	}

	merge(): DaemonInfo[] {
		return mergeDaemonRosters(this.#sources);
	}
}
