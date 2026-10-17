import { describe, expect, test } from "bun:test";
import {
	projectRollup,
	rowAction,
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

describe("rowAction", () => {
	test("never-started asleep rows offer Start", () => {
		expect(rowAction("asleep")).toEqual({ kind: "start", label: "Start" });
	});

	test("running, crashed, and user-stopped rows offer Restart", () => {
		expect(rowAction("ready")).toEqual({ kind: "restart", label: "Restart" });
		expect(rowAction("error")).toEqual({ kind: "restart", label: "Restart" });
		expect(rowAction("asleep", { stoppedByUser: true })).toEqual({
			kind: "restart",
			label: "Restart",
		});
	});

	test("in-between states offer nothing", () => {
		expect(rowAction("spawning")).toBeNull();
		expect(rowAction("reconnecting")).toBeNull();
		expect(rowAction("asleep", { waking: true })).toBeNull();
	});
});

describe("projectRollup", () => {
	test("empty project has no roll-up", () => {
		expect(projectRollup([])).toBe("");
	});

	test("counts running and crashed workspaces", () => {
		expect(projectRollup([{ status: "ready" }, { status: "ready" }])).toBe("2 running");
		expect(projectRollup([{ status: "ready" }, { status: "error" }])).toBe("1 running · 1 crashed");
	});

	test("falls back to asleep only when nothing is up", () => {
		expect(projectRollup([{ status: "asleep" }, { status: "asleep" }])).toBe("2 asleep");
		expect(projectRollup([{ status: "ready" }, { status: "asleep" }])).toBe("1 running");
	});
});

describe("workspaceName", () => {
	test("prefers the branch and falls back to the workspace name", () => {
		expect(workspaceName({ branch: "feat/x", name: "x" })).toBe("feat/x");
		expect(workspaceName({ name: "repo-2" })).toBe("repo-2");
	});
});
