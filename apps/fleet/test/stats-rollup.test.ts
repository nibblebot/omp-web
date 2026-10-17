import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { buildRollup } from "../stats-rollup";

const DAY = 86_400_000;
/** 2026-02-10 12:00 UTC. */
const NOW = Date.UTC(2026, 1, 10, 12);

function makeDb(): Database {
	const db = new Database(":memory:");
	db.exec(
		`CREATE TABLE messages (timestamp INTEGER, stop_reason TEXT, model TEXT, provider TEXT,
     folder TEXT, total_tokens INTEGER, cost_total REAL, session_file TEXT)`,
	);
	db.exec(
		"CREATE TABLE tool_calls (timestamp INTEGER, tool_name TEXT, is_error INTEGER, session_file TEXT)",
	);
	return db;
}

function addTurn(
	db: Database,
	ts: number,
	opts: { model?: string; cost?: number; stop?: string; session?: string } = {},
): void {
	db.query(
		"INSERT INTO messages (timestamp, stop_reason, model, provider, folder, total_tokens, cost_total, session_file) VALUES (?, ?, ?, 'prov', 'proj', 100, ?, ?)",
	).run(ts, opts.stop ?? "done", opts.model ?? "m1", opts.cost ?? 0.5, opts.session ?? "s1");
}

function addCall(db: Database, ts: number, tool: string, isError = 0): void {
	db.query(
		"INSERT INTO tool_calls (timestamp, tool_name, is_error, session_file) VALUES (?, ?, ?, 's1')",
	).run(ts, tool, isError);
}

describe("buildRollup", () => {
	test("zero-fills buckets oldest first, one per local day", () => {
		const db = makeDb();
		addTurn(db, NOW, { cost: 0.5 });
		const r = buildRollup(db, 3, 0, NOW);
		expect(r.buckets.map((b) => b.ts)).toEqual([
			Date.UTC(2026, 1, 8),
			Date.UTC(2026, 1, 9),
			Date.UTC(2026, 1, 10),
		]);
		expect(r.buckets.map((b) => b.turns)).toEqual([0, 0, 1]);
		expect(r.buckets[2]!.cost).toBeCloseTo(0.5);
		expect(r.since).toBe(Date.UTC(2026, 1, 8));
		expect(r.totals.turns).toBe(1);
	});

	test("the UTC offset moves a turn into the local day it falls on", () => {
		const db = makeDb();
		// 20:00 UTC on Feb 9 is 06:00 on Feb 10 at UTC+10.
		addTurn(db, Date.UTC(2026, 1, 9, 20));
		expect(buildRollup(db, 3, 0, NOW).buckets.map((b) => b.turns)).toEqual([0, 1, 0]);
		expect(buildRollup(db, 3, 600, NOW).buckets.map((b) => b.turns)).toEqual([0, 0, 1]);
	});

	test("folds models beyond the top six into (other)", () => {
		const db = makeDb();
		// m0 costs the most, m6 the least; only m6 should fall into (other).
		for (let i = 0; i < 7; i++) addTurn(db, NOW, { model: `m${i}`, cost: 7 - i });
		const r = buildRollup(db, 1, 0, NOW);
		const names = r.modelSeries.map((s) => s.name);
		expect(names).toHaveLength(7);
		expect(names).toContain("(other)");
		expect(names).not.toContain("m6");
		expect(r.modelSeries.find((s) => s.name === "(other)")?.values[0]).toBeCloseTo(1);
	});

	test("counts error turns and tool errors, per model and per tool", () => {
		const db = makeDb();
		addTurn(db, NOW, { stop: "error", cost: 0 });
		addTurn(db, NOW - 1000, { cost: 1 });
		addCall(db, NOW - 500, "bash", 1);
		addCall(db, NOW - 400, "bash", 0);
		addCall(db, NOW - 300, "read", 0);
		const r = buildRollup(db, 1, 0, NOW);
		expect(r.totals.errors).toBe(1);
		expect(r.totals.toolCalls).toBe(3);
		expect(r.tools.find((t) => t.name === "bash")).toEqual({ name: "bash", calls: 2, errors: 1 });
		expect(r.models[0]).toMatchObject({ model: "m1", turns: 2, errors: 1 });
	});

	test("an empty database still returns a full zero-filled window", () => {
		const r = buildRollup(makeDb(), 7, 0, NOW);
		expect(r.buckets).toHaveLength(7);
		expect(r.buckets[6]!.ts - r.buckets[0]!.ts).toBe(6 * DAY);
		expect(r.totals.turns).toBe(0);
		expect(r.models).toEqual([]);
	});
});
