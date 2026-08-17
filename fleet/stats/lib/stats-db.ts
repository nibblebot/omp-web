/**
 * Read-only SQLite access to omp's stats.db (bun:sqlite) with rotation-aware
 * reprobing. Implements the StatsDbManager contract from fleet/stats/types.ts.
 *
 * Never writes. WAL caveat (PLAN.md §4.1): stats.db runs in WAL mode; a
 * readonly open needs -wal/-shm sidecars. If open fails with
 * SQLITE_READONLY_CANTINIT (missing -shm after a crash), fall back to
 * copying db + wal + shm to a temp dir and opening the copy. Copies are
 * atomic: each sidecar lands under a temp name and is renamed into place,
 * so a half-written temp db can never be observed.
 */
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StatsDbManager } from "../types";

interface DbStat {
	mtimeMs: number;
	size: number;
}

/**
 * Opens a stats.db path read-only with query_only enforced. Injectable so
 * tests can simulate the WAL-fallback trigger (SQLITE_READONLY_CANTINIT on
 * platforms where the bundled SQLite still requires -shm creation).
 */
export type DbOpener = (path: string) => Database;

function defaultOpenDb(path: string): Database {
	const db = new Database(path, { readonly: true });
	db.exec("PRAGMA query_only = ON");
	return db;
}

export class StatsDbManagerImpl implements StatsDbManager {
	readonly #target: string;
	readonly #openDb: DbOpener;
	#handle: Database | null = null;
	#path: string | null = null;
	#fromCopy = false;
	#tempDir: string | null = null;
	/** last observed stat of the target (null = missing at last probe) */
	#stat: DbStat | null = null;

	constructor(target: string, openDb: DbOpener = defaultOpenDb) {
		this.#target = target;
		this.#openDb = openDb;
		this.reprobe();
	}

	db(): Database | null {
		return this.#handle;
	}

	path(): string | null {
		return this.#path;
	}

	fromCopy(): boolean {
		return this.#fromCopy;
	}

	reprobe(): void {
		const stat = this.#statTarget();
		if (this.#handle) {
			if (
				stat &&
				this.#stat &&
				stat.mtimeMs === this.#stat.mtimeMs &&
				stat.size === this.#stat.size
			) {
				return; // unchanged — no-op
			}
			// Missing now, or mtime/size moved → rotation. Drop the prior handle
			// (and any temp copy) before reopening.
			console.log("[stats-db] rotation detected; reopening", {
				path: this.#target,
				prior: this.#stat,
				next: stat,
			});
			this.#dispose();
		}
		if (stat) this.#open(stat);
		this.#stat = stat; // null when missing — a later probe sees missing→present
	}

	close(): void {
		if (this.#handle === null && this.#tempDir === null) return;
		this.#dispose();
		console.log("[stats-db] close", { path: this.#target });
	}

	/** Release resources without lifecycle logging (used by rotation). */
	#dispose(): void {
		if (this.#handle) {
			try {
				this.#handle.close();
			} catch {
				// Already closed / never fully opened.
			}
			this.#handle = null;
		}
		this.#path = null;
		this.#fromCopy = false;
		this.#stat = null;
		if (this.#tempDir) {
			try {
				rmSync(this.#tempDir, { recursive: true, force: true });
			} catch {
				// Temp dir already gone — best effort.
			}
			this.#tempDir = null;
		}
	}

	#statTarget(): DbStat | null {
		try {
			const s = statSync(this.#target);
			return { mtimeMs: s.mtimeMs, size: s.size };
		} catch {
			return null;
		}
	}

	#open(stat: DbStat): void {
		// Direct readonly open.
		try {
			const db = this.#openDb(this.#target);
			this.#handle = db;
			this.#path = this.#target;
			this.#fromCopy = false;
			this.#stat = stat;
			return;
		} catch (err) {
			console.error("[stats-db] open failed; trying WAL fallback", {
				path: this.#target,
				error: err,
			});
		}
		// WAL fallback: copy db + sidecars into a fresh temp dir, then open the
		// copy. Each sidecar is copied to a temp name and renamed into place so
		// the fallback db can never be observed half-written.
		let dir: string | null = null;
		try {
			dir = mkdtempSync(join(tmpdir(), "omp-sv-"));
			for (const suffix of ["", "-wal", "-shm"]) {
				const src = this.#target + suffix;
				if (!existsSync(src)) continue;
				const dst = join(dir, "stats.db" + suffix);
				const tmp = `${dst}.tmp`;
				copyFileSync(src, tmp);
				renameSync(tmp, dst);
			}
			const db = this.#openDb(join(dir, "stats.db"));
			console.error("[stats-db] WAL fallback engaged", { path: this.#target, tempDir: dir });
			this.#handle = db;
			this.#path = join(dir, "stats.db");
			this.#fromCopy = true;
			this.#tempDir = dir;
			this.#stat = stat;
		} catch (err) {
			console.error("[stats-db] open failed", { path: this.#target, error: err });
			if (dir) {
				try {
					rmSync(dir, { recursive: true, force: true });
				} catch {
					// Best effort.
				}
			}
		}
	}
}
