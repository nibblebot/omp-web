/**
 * StatsDbManagerImpl lifecycle: missing→present pickup, rotation reopen,
 * WAL-fallback temp copy + close cleanup. Unit-level — no server involved.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { StatsDbManagerImpl } from "../fleet/stats/lib/stats-db";

const scratch: string[] = [];

function tmpDir(): string {
	const d = mkdtempSync(join(tmpdir(), "svm-"));
	scratch.push(d);
	return d;
}

afterEach(() => {
	for (const d of scratch.splice(0)) {
		rmSync(d, { recursive: true, force: true });
	}
});

/** (Re)write a stats.db with one row carrying the marker. */
function writeDb(path: string, marker: string): void {
	const db = new Database(path);
	db.exec("CREATE TABLE IF NOT EXISTS t (v TEXT)");
	db.exec("DELETE FROM t");
	db.query("INSERT INTO t VALUES (?)").run(marker);
	db.close();
}

const readMarker = (db: Database): string => {
	const row = db.query("SELECT v FROM t").get();
	if (row !== null && typeof row === "object" && "v" in row) return row.v as string;
	throw new Error("marker row missing");
};

describe("StatsDbManagerImpl", () => {
	test("missing stats.db → db() null, path() null, fromCopy() false", () => {
		const m = new StatsDbManagerImpl(join(tmpDir(), "stats.db"));
		expect(m.db()).toBeNull();
		expect(m.path()).toBeNull();
		expect(m.fromCopy()).toBe(false);
		m.close();
	});

	test("missing → present: reprobe picks the db up", () => {
		const dbPath = join(tmpDir(), "stats.db");
		const m = new StatsDbManagerImpl(dbPath);
		expect(m.db()).toBeNull();

		writeDb(dbPath, "later");
		m.reprobe();

		expect(m.db()).not.toBeNull();
		expect(m.path()).toBe(dbPath);
		expect(m.fromCopy()).toBe(false);
		expect(readMarker(m.db()!)).toBe("later");
		m.close();
	});

	test("unchanged file → reprobe is a no-op (same handle)", () => {
		const dbPath = join(tmpDir(), "stats.db");
		writeDb(dbPath, "stable");
		const m = new StatsDbManagerImpl(dbPath);
		const first = m.db();
		m.reprobe();
		expect(m.db()).toBe(first);
		m.close();
	});

	test("rotation (size/mtime change) → new handle with fresh data", () => {
		const dbPath = join(tmpDir(), "stats.db");
		writeDb(dbPath, "one");
		const m = new StatsDbManagerImpl(dbPath);
		const first = m.db();
		expect(first).not.toBeNull();

		writeDb(dbPath, "two-two-two-two-two"); // different size forces rotation
		m.reprobe();

		const second = m.db();
		expect(second).not.toBeNull();
		expect(second).not.toBe(first);
		expect(readMarker(second!)).toBe("two-two-two-two-two");
		expect(m.path()).toBe(dbPath);
		expect(m.fromCopy()).toBe(false);
		m.close();
	});

	test("fallback: direct open throws → atomic temp copy; close removes it", () => {
		const dbPath = join(tmpDir(), "stats.db");
		writeDb(dbPath, "copy-me");

		let tempOpens = 0;
		const m = new StatsDbManagerImpl(dbPath, (p) => {
			if (p === dbPath) throw new Error("simulated SQLITE_READONLY_CANTINIT");
			tempOpens++;
			const db = new Database(p, { readonly: true });
			db.exec("PRAGMA query_only = ON");
			return db;
		});
		try {
			expect(m.db()).not.toBeNull();
			expect(m.fromCopy()).toBe(true);
			const p = m.path()!;
			expect(p).toContain("omp-sv-");
			expect(p).not.toBe(dbPath);
			expect(tempOpens).toBe(1);

			// Atomic copy: exactly the db file, no half-written .tmp remnants.
			const tempDir = p.slice(0, p.lastIndexOf(sep));
			expect(existsSync(tempDir)).toBe(true);
			const files = readdirSync(tempDir);
			expect(files.includes("stats.db")).toBe(true);
			expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
			expect(readMarker(m.db()!)).toBe("copy-me");

			m.close();
			expect(existsSync(tempDir)).toBe(false);
			expect(m.db()).toBeNull();
			expect(m.path()).toBeNull();
			expect(m.fromCopy()).toBe(false);
			m.close(); // idempotent
		} finally {
			m.close();
		}
	});
});
