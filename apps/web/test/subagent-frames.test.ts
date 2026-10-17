import { describe, expect, test } from "bun:test";
import type { SubagentInfo } from "../state";
import {
	applyLifecycleFrame,
	applyProgressFrame,
	lastToolOf,
	mergeProgress,
	metricsOf,
	normalizeStatus,
} from "../store/subagent-frames";

const NOW = 10_000;

function byId(map: ReadonlyMap<string, SubagentInfo>, id: string): SubagentInfo {
	const info = map.get(id);
	if (!info) throw new Error(`missing ${id}`);
	return info;
}

describe("mergeProgress", () => {
	test("full frames replace the record and drop nulls", () => {
		expect(mergeProgress({ a: 1, b: 2 }, { a: 9, c: null }, false)).toEqual({ a: 9 });
	});

	test("delta frames patch: absent keys stay, null clears, values set", () => {
		const merged = mergeProgress(
			{ id: "p", tokens: 5, cost: 1, status: "running" },
			{ tokens: 7, cost: null },
			true,
		);
		expect(merged).toEqual({ id: "p", tokens: 7, status: "running" });
	});
});

describe("applyProgressFrame", () => {
	test("keys by progress.id and merges delta frames over the previous record", () => {
		const first = applyProgressFrame(
			new Map(),
			{
				index: 0,
				agent: "task",
				task: "t",
				progress: { id: "a1", status: "running", tokens: 10, cost: 0.5 },
			},
			NOW,
		);
		const second = applyProgressFrame(
			first,
			{ index: 0, agent: "task", delta: true, progress: { id: "a1", tokens: 40 } },
			NOW + 1000,
		);
		const info = byId(second, "a1");
		expect(info.status).toBe("running");
		expect(info.progress).toMatchObject({ tokens: 40, cost: 0.5 });
		expect(info.task).toBe("t");
	});

	test("frames without index are kept when they carry an id", () => {
		const next = applyProgressFrame(new Map(), { progress: { id: "x", status: "running" } }, NOW);
		expect(byId(next, "x").status).toBe("running");
	});

	test("id-less frames fall back to the index placeholder and migrate on lifecycle", () => {
		const progressed = applyProgressFrame(
			new Map(),
			{ index: 2, progress: { status: "running", tokens: 3 } },
			NOW,
		);
		expect(progressed.has("progress-2")).toBe(true);
		const started = applyLifecycleFrame(
			progressed,
			{ id: "real", index: 2, agent: "task", status: "started" },
			NOW,
		);
		expect(started.has("progress-2")).toBe(false);
		expect(byId(started, "real").progress).toMatchObject({ tokens: 3 });
	});

	test("terminal status records endedAt once and retains the entry", () => {
		const running = applyProgressFrame(
			new Map(),
			{ progress: { id: "d", status: "running" } },
			NOW,
		);
		const done = applyProgressFrame(
			running,
			{ progress: { id: "d", status: "completed" } },
			NOW + 500,
		);
		const again = applyProgressFrame(
			done,
			{ progress: { id: "d", status: "completed" } },
			NOW + 900,
		);
		expect(byId(again, "d").endedAt).toBe(NOW + 500);
		expect(byId(again, "d").status).toBe("completed");
	});
});

describe("applyLifecycleFrame", () => {
	test("a late non-terminal lifecycle frame does not reopen a finished agent", () => {
		const done = applyLifecycleFrame(
			new Map(),
			{ id: "a", index: 0, agent: "task", status: "completed" },
			NOW,
		);
		const late = applyLifecycleFrame(
			done,
			{ id: "a", index: 0, agent: "task", status: "started" },
			NOW + 5,
		);
		expect(byId(late, "a").status).toBe("completed");
	});

	test("the lifecycle frame does not drop existing progress metrics", () => {
		const progressed = applyProgressFrame(
			new Map(),
			{ index: 1, progress: { id: "b", tokens: 8 } },
			NOW,
		);
		const lifecycle = applyLifecycleFrame(
			progressed,
			{ id: "b", index: 1, agent: "task", status: "completed" },
			NOW + 1,
		);
		expect(byId(lifecycle, "b").progress).toMatchObject({ tokens: 8 });
	});

	test("lifecycle frames alone drive status from started to completed", () => {
		const started = applyLifecycleFrame(
			new Map(),
			{ id: "c", index: 2, agent: "task", status: "started" },
			NOW,
		);
		expect(byId(started, "c").status).toBe("started");
		const done = applyLifecycleFrame(
			started,
			{ id: "c", index: 2, agent: "task", status: "completed" },
			NOW + 1,
		);
		expect(byId(done, "c").status).toBe("completed");
	});
});

describe("metricsOf", () => {
	test("live progress is the source; durationMs is elapsed", () => {
		const info = byId(
			applyProgressFrame(
				new Map(),
				{
					progress: {
						id: "m",
						tokens: 100,
						cost: 0.25,
						durationMs: 4200,
						contextTokens: 50,
						contextWindow: 200,
					},
				},
				NOW,
			),
			"m",
		);
		expect(metricsOf(info, NOW)).toEqual({
			elapsedMs: 4200,
			contextPercent: 25,
			tokens: 100,
			cost: 0.25,
		});
	});

	test("roster usage is the fallback when no live progress exists", () => {
		const info = byId(
			applyLifecycleFrame(new Map(), { id: "f", index: 0, agent: "task", status: "started" }, NOW),
			"f",
		);
		const metrics = metricsOf(info, NOW + 2000, { tokens: 7, cost: 0.01 });
		expect(metrics.tokens).toBe(7);
		expect(metrics.cost).toBe(0.01);
		expect(metrics.elapsedMs).toBe(2000);
		expect(metrics.contextPercent).toBeUndefined();
	});

	test("elapsed freezes at the end time once the agent is terminal", () => {
		const info = byId(
			applyLifecycleFrame(
				new Map(),
				{ id: "t", index: 0, agent: "task", status: "completed" },
				NOW,
			),
			"t",
		);
		expect(metricsOf(info, NOW + 60_000).elapsedMs).toBe(0);
	});
});

describe("lastToolOf", () => {
	test("prefers the lastTool object, then the last recent tool, then currentTool", () => {
		const base = byId(
			applyProgressFrame(new Map(), { progress: { id: "l", lastTool: { tool: "read" } } }, NOW),
			"l",
		);
		expect(lastToolOf(base)).toBe("read");
		const recent = byId(
			applyProgressFrame(
				new Map(),
				{ progress: { id: "l", recentTools: [{ tool: "grep" }, { tool: "edit" }] } },
				NOW,
			),
			"l",
		);
		expect(lastToolOf(recent)).toBe("edit");
		const current = byId(
			applyProgressFrame(new Map(), { progress: { id: "l", currentTool: "bash" } }, NOW),
			"l",
		);
		expect(lastToolOf(current)).toBe("bash");
	});
});

describe("normalizeStatus", () => {
	test("maps wire vocabulary onto the contract", () => {
		expect(normalizeStatus("started")).toBe("running");
		expect(normalizeStatus("running")).toBe("running");
		expect(normalizeStatus("idle")).toBe("done");
		expect(normalizeStatus("completed")).toBe("done");
		expect(normalizeStatus("failed")).toBe("failed");
		expect(normalizeStatus("aborted")).toBe("aborted");
		expect(normalizeStatus("parked")).toBe("parked");
		expect(normalizeStatus(undefined)).toBe("pending");
	});
});
