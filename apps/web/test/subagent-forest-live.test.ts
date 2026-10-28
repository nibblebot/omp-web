/** The shared forest follows the live mirror (written in place) and the roster, and a quiet roster read changes nothing. */
import { beforeEach, describe, expect, test } from "bun:test";
import { setState, state } from "../state";
import {
	applySubagentLifecycle,
	applySubagentProgress,
	createWorkersState,
	fanoutTotals,
	normalizeWorkerSnapshot,
	runningSubagentCount,
	subagentById,
	subagentForest,
	subagentTree,
	workerKey,
} from "../store/subagents";

const SESSION = "forest-live";

beforeEach(() => {
	setState("currentWorkspaceId", SESSION);
	setState("subagents", new Map());
	setState("workers", createWorkersState());
});

const lifecycle = (id: string, status: string, call = "call-1") =>
	applySubagentLifecycle({ id, index: 0, agent: "task", status, parentToolCallId: call });
const progress = (id: string, fields: object, call = "call-1") =>
	applySubagentProgress({
		index: 0,
		parentToolCallId: call,
		delta: true,
		progress: { id, ...fields },
	});

describe("forest over the live mirror", () => {
	test("frames show up in every read of the forest without replacing the mirror", () => {
		const mirror = state.subagents;
		lifecycle("Owl", "started");
		lifecycle("Wren", "started");
		const upgraded = state.subagents;
		expect(subagentForest().map((node) => node.id)).toEqual(["Owl", "Wren"]);
		expect(runningSubagentCount()).toBe(2);

		progress("Owl", { status: "running", tokens: 40, cost: 0.5, durationMs: 10 });
		expect(state.subagents).toBe(upgraded);
		expect(mirror).not.toBe(upgraded);
		expect(subagentById("Owl")?.metrics.tokens).toBe(40);
		expect(subagentTree("call-1")).toHaveLength(2);
		expect(fanoutTotals("call-1")).toMatchObject({ count: 2, running: 2, tokens: 40 });

		lifecycle("Owl", "completed");
		expect(subagentById("Owl")?.status).toBe("done");
		expect(runningSubagentCount()).toBe(1);
		expect(fanoutTotals("call-1").running).toBe(1);
	});

	test("an agent another call spawned does not move this call's totals", () => {
		lifecycle("Owl", "started", "call-a");
		lifecycle("Wren", "started", "call-b");
		progress("Owl", { status: "running", tokens: 5 }, "call-a");
		const { elapsedMs: _, ...before } = fanoutTotals("call-b");
		progress("Owl", { tokens: 9 }, "call-a");
		const { elapsedMs: __, ...after } = fanoutTotals("call-b");
		expect(after).toEqual(before);
		expect(fanoutTotals("call-a").tokens).toBe(9);
	});

	test("the roster supplies the parent links the live frames lack", () => {
		lifecycle("Parent", "started");
		lifecycle("Parent.Child", "started");
		expect(subagentForest()).toHaveLength(2);
		const key = workerKey(SESSION, "Parent.Child");
		setState(
			"workers",
			normalizeWorkerSnapshot(createWorkersState(), SESSION, [
				{
					id: "Parent.Child",
					sessionId: SESSION,
					displayName: "child",
					status: "running",
					parentAgentId: "Parent",
				},
			]),
		);
		expect(state.workers.order).toEqual([key]);
		expect(subagentForest().map((node) => node.id)).toEqual(["Parent"]);
		expect(subagentById("Parent")?.children.map((node) => node.id)).toEqual(["Parent.Child"]);
	});
});

describe("normalizeWorkerSnapshot", () => {
	const row = { id: "w", sessionId: SESSION, displayName: "w", status: "running" };

	test("a snapshot that changes nothing hands back the state it was given", () => {
		const first = normalizeWorkerSnapshot(createWorkersState(), SESSION, [row]);
		expect(normalizeWorkerSnapshot(first, SESSION, [{ ...row }])).toBe(first);
	});

	test("a changed row replaces only its own record", () => {
		const other = { ...row, id: "x" };
		const first = normalizeWorkerSnapshot(createWorkersState(), SESSION, [row, other]);
		const next = normalizeWorkerSnapshot(first, SESSION, [{ ...row, status: "completed" }, other]);
		expect(next.records[workerKey(SESSION, "w")]?.status).toBe("completed");
		expect(next.records[workerKey(SESSION, "x")]).toBe(first.records[workerKey(SESSION, "x")]);
		expect(next.order).toEqual(first.order);
	});
});
