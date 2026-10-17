import { beforeEach, describe, expect, test } from "bun:test";
import { setState } from "../state";
import { applyProgressFrame } from "../store/subagent-frames";
import type { SubagentInfo } from "../state";
import {
	agentPaneActions,
	createWorkersState,
	fanoutTotals,
	runningSubagentCount,
	subagentById,
	subagentCapabilities,
	subagentCount,
	subagentForest,
	subagentTree,
	type WorkerRecord,
	workerKey,
} from "../store/subagents";

const SESSION = "s1";
const NOW = 10_000;

interface Seed {
	id: string;
	status: string;
	tokens?: number;
	cost?: number;
	parent?: string;
	toolCallId?: string;
	startedAt?: number;
	endedAt?: number;
	lastUpdate?: number;
	rosterStatus?: string;
	rosterActivity?: number;
}

/** Seeds live subagent state and the matching roster records for the attached session. */
function seed(agents: Seed[]): void {
	let live = new Map<string, SubagentInfo>();
	const records: Record<string, WorkerRecord> = {};
	const order: string[] = [];
	for (const agent of agents) {
		live = applyProgressFrame(
			live,
			{
				index: 0,
				agent: "task",
				task: "t",
				parentToolCallId: agent.toolCallId,
				progress: {
					id: agent.id,
					status: agent.status,
					tokens: agent.tokens ?? 0,
					cost: agent.cost ?? 0,
				},
			},
			agent.lastUpdate ?? NOW,
		);
		const info = live.get(agent.id);
		if (!info) throw new Error(`seed lost ${agent.id}`);
		live.set(agent.id, { ...info, startedAt: agent.startedAt, endedAt: agent.endedAt });
		const key = workerKey(SESSION, agent.id);
		records[key] = {
			id: agent.id,
			agentId: agent.id,
			sessionId: SESSION,
			displayName: "task",
			status: agent.rosterStatus ?? agent.status,
			parentAgentId: agent.parent,
			parentToolCallId: agent.toolCallId,
			lastActivity: agent.rosterActivity ?? 0,
			createdAt: agent.startedAt ?? 0,
			revivable: false,
		} as WorkerRecord;
		order.push(key);
	}
	setState("currentSessionId", SESSION);
	setState("subagents", live);
	setState("workers", { ...createWorkersState(), records, order });
}

beforeEach(() => {
	setState("currentSessionId", SESSION);
	setState("subagents", new Map<string, SubagentInfo>());
	setState("workers", createWorkersState());
});

describe("subagentForest", () => {
	test("nests children under their parent and sums subtree tokens and cost", () => {
		seed([
			{ id: "p", status: "running", tokens: 100, cost: 1, startedAt: 1, toolCallId: "t1" },
			{ id: "c", status: "done", tokens: 50, cost: 0.5, parent: "p", startedAt: 2, endedAt: 3 },
		]);
		const [root] = subagentForest();
		expect(root?.id).toBe("p");
		expect(root?.children.map((child) => child.id)).toEqual(["c"]);
		expect(root?.subtree).toEqual({ tokens: 150, cost: 1.5 });
		expect(root?.children[0]?.subtree).toEqual({ tokens: 50, cost: 0.5 });
	});

	test("orders roots by start time", () => {
		seed([
			{ id: "late", status: "done", startedAt: 5, endedAt: 6 },
			{ id: "early", status: "done", startedAt: 2, endedAt: 3 },
		]);
		expect(subagentForest().map((node) => node.id)).toEqual(["early", "late"]);
	});

	test("retains terminal agents even when the roster no longer lists them", () => {
		seed([{ id: "a", status: "failed", startedAt: 1, endedAt: 5 }]);
		setState("workers", createWorkersState());
		const [node] = subagentForest();
		expect(node?.id).toBe("a");
		expect(node?.status).toBe("failed");
	});
});

describe("subagentTree and fanoutTotals", () => {
	beforeEach(() => {
		seed([
			{ id: "a", status: "running", tokens: 10, cost: 0.1, toolCallId: "t1", startedAt: 100 },
			{
				id: "a1",
				status: "done",
				tokens: 3,
				cost: 0.03,
				parent: "a",
				startedAt: 105,
				endedAt: 108,
			},
			{
				id: "b",
				status: "failed",
				tokens: 20,
				cost: 0.2,
				toolCallId: "t1",
				startedAt: 110,
				endedAt: 150,
			},
			{
				id: "x",
				status: "done",
				tokens: 5,
				cost: 0.05,
				toolCallId: "t2",
				startedAt: 120,
				endedAt: 130,
			},
		]);
	});

	test("subagentTree returns only the roots of one Task call, with children nested", () => {
		const tree = subagentTree("t1");
		expect(tree.map((node) => node.id)).toEqual(["a", "b"]);
		expect(tree[0]?.children.map((child) => child.id)).toEqual(["a1"]);
	});

	test("fanoutTotals counts every descendant and sums tokens and cost", () => {
		const totals = fanoutTotals("t1");
		expect(totals.count).toBe(3);
		expect(totals.running).toBe(1);
		expect(totals.failed).toBe(1);
		expect(totals.tokens).toBe(33);
		expect(totals.cost).toBeCloseTo(0.33, 10);
	});

	test("fanoutTotals elapsed time spans first start to last end", () => {
		expect(fanoutTotals("t2").elapsedMs).toBe(10);
	});

	test("fanoutTotals is empty for an unknown Task call", () => {
		expect(fanoutTotals("nope")).toEqual({
			count: 0,
			running: 0,
			failed: 0,
			tokens: 0,
			cost: 0,
			elapsedMs: 0,
		});
	});
});

describe("runningSubagentCount and subagentById", () => {
	test("counts running agents at every depth", () => {
		seed([
			{ id: "p", status: "running", startedAt: 1 },
			{ id: "c", status: "running", parent: "p", startedAt: 2 },
			{ id: "d", status: "done", startedAt: 3, endedAt: 4 },
		]);
		expect(runningSubagentCount()).toBe(2);
	});

	test("finds nested agents by id and returns undefined for unknown ids", () => {
		seed([
			{ id: "p", status: "running", startedAt: 1 },
			{ id: "c", status: "done", parent: "p", startedAt: 2, endedAt: 3 },
		]);
		expect(subagentById("c")?.parentId).toBe("p");
		expect(subagentById("missing")).toBeUndefined();
	});
});

describe("status precedence", () => {
	test("a live running frame beats a roster done record", () => {
		seed([{ id: "a", status: "running", rosterStatus: "done" }]);
		expect(subagentById("a")?.status).toBe("running");
	});

	test("a newer roster park beats the live status", () => {
		seed([
			{
				id: "a",
				status: "done",
				lastUpdate: 100,
				rosterStatus: "parked",
				rosterActivity: 200,
			},
		]);
		expect(subagentById("a")?.status).toBe("parked");
	});

	test("an older roster park does not override a newer live update", () => {
		seed([
			{
				id: "a",
				status: "running",
				lastUpdate: 100,
				rosterStatus: "parked",
				rosterActivity: 50,
			},
		]);
		expect(subagentById("a")?.status).toBe("running");
	});

	test("with no live entry, the roster status is used", () => {
		seed([{ id: "a", status: "running", rosterStatus: "parked" }]);
		setState("subagents", new Map<string, SubagentInfo>());
		expect(subagentById("a")?.status).toBe("parked");
	});
});

describe("subagentCapabilities", () => {
	test("running agents can be steered and aborted, not parked", () => {
		seed([{ id: "a", status: "running" }]);
		expect(subagentCapabilities("a")).toEqual({
			steer: true,
			abort: true,
			park: false,
			revive: false,
		});
	});

	test("done agents can be parked only", () => {
		seed([{ id: "a", status: "done", startedAt: 1, endedAt: 2 }]);
		expect(subagentCapabilities("a")).toEqual({
			steer: false,
			abort: false,
			park: true,
			revive: false,
		});
	});

	test("parked agents can be revived", () => {
		seed([{ id: "a", status: "parked" }]);
		expect(subagentCapabilities("a").revive).toBe(true);
	});

	test("unknown agents expose no capabilities", () => {
		expect(subagentCapabilities("missing")).toEqual({
			steer: false,
			abort: false,
			park: false,
			revive: false,
		});
	});
});

describe("agent pane actions", () => {
	const actionsOf = (status: string) => {
		seed([{ id: "a", status, startedAt: 1, endedAt: 2 }]);
		return agentPaneActions(subagentCapabilities("a"));
	};

	test("each status offers exactly what its capabilities allow", () => {
		expect(actionsOf("running")).toEqual(["steer", "abort"]);
		expect(actionsOf("pending")).toEqual(["abort"]);
		expect(actionsOf("done")).toEqual(["park"]);
		expect(actionsOf("parked")).toEqual(["revive"]);
	});

	test("unknown agents offer no actions", () => {
		expect(agentPaneActions(subagentCapabilities("missing"))).toEqual([]);
	});
});

describe("subagentCount", () => {
	test("counts roster agents that have no live mirror entry, e.g. after a reload", () => {
		seed([
			{ id: "a", status: "parked" },
			{ id: "b", status: "done", startedAt: 1, endedAt: 2 },
		]);
		setState("subagents", new Map<string, SubagentInfo>());
		expect(subagentCount()).toBe(2);
	});

	test("is zero when no agents exist", () => {
		setState("subagents", new Map<string, SubagentInfo>());
		expect(subagentCount()).toBe(0);
	});
});
