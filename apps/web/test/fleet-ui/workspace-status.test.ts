import { describe, expect, test } from "bun:test";
import {
	projectRollup,
	rollupSummary,
	canStartRow,
	sessionChip,
	workspaceName,
} from "../../fleet-ui/workspace-status";

describe("sessionChip", () => {
	test("maps roster statuses to text chips", () => {
		expect(sessionChip("ready").kind).toBe("running");
		expect(sessionChip("spawning").kind).toBe("starting");
		expect(sessionChip("asleep").kind).toBe("asleep");
		expect(sessionChip("reconnecting").kind).toBe("reconnecting");
		expect(sessionChip("error").kind).toBe("crashed");
	});

	test("a user-stopped asleep process reads Stopped, not Asleep", () => {
		expect(sessionChip("asleep", { stoppedByUser: true })).toMatchObject({
			kind: "stopped",
			label: "Stopped",
		});
	});

	test("a wake in flight reads Starting while the roster still says asleep", () => {
		expect(sessionChip("asleep", { waking: true }).kind).toBe("starting");
	});

	test("every chip carries a label and a non-empty tooltip", () => {
		for (const status of ["ready", "spawning", "asleep", "reconnecting", "error"] as const) {
			const chip = sessionChip(status);
			expect(chip.label.length).toBeGreaterThan(0);
			expect(chip.title.length).toBeGreaterThan(0);
		}
	});
});

describe("canStartRow", () => {
	test("asleep and crashed rows offer Start, user-stopped ones included", () => {
		expect(canStartRow("asleep")).toBe(true);
		expect(canStartRow("asleep", { stoppedByUser: true })).toBe(true);
		expect(canStartRow("error")).toBe(true);
	});

	test("running rows offer only Stop", () => {
		expect(canStartRow("ready")).toBe(false);
	});

	test("in-between states offer nothing", () => {
		expect(canStartRow("spawning")).toBe(false);
		expect(canStartRow("reconnecting")).toBe(false);
		expect(canStartRow("asleep", { waking: true })).toBe(false);
	});
});

describe("projectRollup", () => {
	test("empty project: no workspaces, no signal", () => {
		expect(projectRollup([])).toEqual({
			live: 0,
			total: 0,
			asleep: 0,
			signal: null,
			breakdown: "No workspaces",
		});
	});

	test("all asleep: nothing live, no signal, counted asleep", () => {
		expect(projectRollup([{ status: "asleep" }, { status: "asleep" }])).toEqual({
			live: 0,
			total: 2,
			asleep: 2,
			signal: null,
			breakdown: "2 asleep",
		});
	});

	test("mixed live and asleep: ready rows are live, idle ones raise no signal", () => {
		const rollup = projectRollup([
			{ status: "ready", activity: "idle" },
			{ status: "ready", activity: "idle" },
			{ status: "asleep" },
			{ status: "asleep" },
			{ status: "asleep" },
		]);
		expect(rollup).toMatchObject({ live: 2, total: 5, asleep: 3, signal: null });
		expect(rollup.breakdown).toBe("2 ready · 3 asleep");
	});

	test("the signal carries a ready row's activity", () => {
		const rollup = projectRollup([
			{ status: "ready", activity: "blocked" },
			{ status: "ready", activity: "idle" },
			{ status: "asleep" },
		]);
		expect(rollup.signal).toEqual({ status: "ready", activity: "blocked" });
		expect(rollup.breakdown).toBe("2 ready (1 blocked) · 1 asleep");
	});

	test("a working ready row and a starting row both read as a spinner signal", () => {
		expect(projectRollup([{ status: "ready", activity: "in_progress" }]).signal).toEqual({
			status: "ready",
			activity: "in_progress",
		});
		expect(projectRollup([{ status: "spawning" }]).signal).toEqual({ status: "spawning" });
	});

	test("urgency: blocked > error > reconnecting > unreviewed > unread > working", () => {
		const rows = {
			blocked: { status: "ready", activity: "blocked" },
			error: { status: "error" },
			reconnecting: { status: "reconnecting" },
			unreviewed: { status: "ready", activity: "unreviewed" },
			unread: { status: "ready", activity: "unread" },
			working: { status: "ready", activity: "in_progress" },
		} as const;
		const order = ["blocked", "error", "reconnecting", "unreviewed", "unread", "working"] as const;
		for (let i = 0; i < order.length; i++) {
			// The row at i beats every row after it, wherever it sits in the list.
			const group = order.slice(i).map((k) => rows[k]);
			expect(projectRollup(group).signal).toEqual(rows[order[i]!]);
			expect(projectRollup([...group].reverse()).signal).toEqual(rows[order[i]!]);
		}
	});

	test("reconnecting is not live; the breakdown spells out every state", () => {
		const rollup = projectRollup([
			{ status: "ready", activity: "in_progress" },
			{ status: "ready", activity: "unread" },
			{ status: "spawning" },
			{ status: "reconnecting" },
			{ status: "error" },
			{ status: "asleep" },
		]);
		expect(rollup).toMatchObject({ live: 2, total: 6, asleep: 1 });
		expect(rollup.breakdown).toBe(
			"2 ready (1 working, 1 unread) · 1 starting · 1 reconnecting · 1 crashed · 1 asleep",
		);
	});
});

describe("rollupSummary", () => {
	test("empty project shows nothing", () => {
		expect(rollupSummary(projectRollup([]))).toBe("");
	});

	test("live workspaces read live/total", () => {
		const rows = [{ status: "ready" }, { status: "asleep" }, { status: "asleep" }] as const;
		expect(rollupSummary(projectRollup(rows))).toBe("1/3");
	});

	test("nothing live reads N asleep", () => {
		expect(rollupSummary(projectRollup([{ status: "asleep" }, { status: "asleep" }]))).toBe(
			"2 asleep",
		);
		expect(rollupSummary(projectRollup([{ status: "error" }, { status: "asleep" }]))).toBe(
			"1 asleep",
		);
	});

	test("nothing live and nothing asleep reads 0/total", () => {
		expect(rollupSummary(projectRollup([{ status: "spawning" }, { status: "error" }]))).toBe("0/2");
	});
});

describe("workspaceName", () => {
	test("prefers the branch and falls back to the workspace name", () => {
		expect(workspaceName({ branch: "feat/x", name: "x" })).toBe("feat/x");
		expect(workspaceName({ name: "repo-2" })).toBe("repo-2");
	});
});
