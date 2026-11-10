import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unwrap } from "solid-js/store";
import { setState, state } from "../state";
import { applyProgressFrame } from "../store/subagent-frames";
import type { SubagentInfo } from "../state";
import {
	agentPaneActions,
	createWorkersState,
	fanoutTotals,
	runningSubagentCount,
	subagentById,
	subagentEstimate,
	subagentCapabilities,
	subagentForest,
	subagentScopeCounts,
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
	/** Extra live progress fields (description, model, tools). */
	extra?: Record<string, unknown>;
	/** Roster assignment text. */
	assignment?: string;
	/** Task text of the progress frame; defaults to "t". */
	task?: string;
	/** The roster's revivable verdict; defaults to false. */
	revivable?: boolean;
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
				task: agent.task ?? "t",
				parentToolCallId: agent.toolCallId,
				progress: {
					id: agent.id,
					status: agent.status,
					tokens: agent.tokens ?? 0,
					cost: agent.cost ?? 0,
					...agent.extra,
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
			assignment: agent.assignment,
			status: agent.rosterStatus ?? agent.status,
			parentAgentId: agent.parent,
			parentToolCallId: agent.toolCallId,
			lastActivity: agent.rosterActivity ?? 0,
			createdAt: agent.startedAt ?? 0,
			revivable: agent.revivable ?? false,
		} as WorkerRecord;
		order.push(key);
	}
	setState("currentWorkspaceId", SESSION);
	setState("subagents", live);
	setState("workers", { ...createWorkersState(), records, order });
}

// The attached session, live subagents and workers as they stood before this file seeded them.
let before: {
	currentWorkspaceId: string;
	subagents: typeof state.subagents;
	workers: typeof state.workers;
};

beforeAll(() => {
	const raw = unwrap(state);
	before = {
		currentWorkspaceId: raw.currentWorkspaceId,
		subagents: raw.subagents,
		workers: { ...raw.workers },
	};
});

// A session left attached makes the next file's connect() re-attach on open.
afterAll(() => setState({ ...before }));

beforeEach(() => {
	setState("currentWorkspaceId", SESSION);
	setState("subagents", new Map<string, SubagentInfo>());
	setState("workers", createWorkersState());
});

describe("node display fields", () => {
	test("name is the last dot segment of the id and keeps the dedup suffix", () => {
		seed([
			{ id: "Explorer", status: "running", startedAt: 1 },
			{ id: "Explorer-2", status: "running", startedAt: 2 },
			{ id: "Explorer.Reader-3", status: "running", startedAt: 3, parent: "Explorer" },
		]);
		expect(subagentById("Explorer")?.name).toBe("Explorer");
		expect(subagentById("Explorer-2")?.name).toBe("Explorer-2");
		expect(subagentById("Explorer.Reader-3")?.name).toBe("Reader-3");
	});

	test("title falls back from description to the first non-empty assignment line to displayName", () => {
		seed([
			{
				id: "a",
				status: "running",
				startedAt: 1,
				extra: { description: "Find the bug" },
				assignment: "ignored",
			},
			{
				id: "b",
				status: "running",
				startedAt: 2,
				assignment: "\n  \n  Review the diff \nsecond line",
			},
			{ id: "c", status: "running", startedAt: 3, task: "" },
		]);
		expect(subagentById("a")?.title).toBe("Find the bug");
		expect(subagentById("b")?.title).toBe("Review the diff");
		expect(subagentById("c")?.title).toBe("task");
	});

	test("model comes from the resolved identity and thinking level of live progress", () => {
		seed([
			{
				id: "a",
				status: "running",
				startedAt: 1,
				extra: {
					resolvedModel: "anthropic/claude-sonnet-5-5:high",
					resolvedModelIdentity: "anthropic/claude-sonnet-5-5",
					resolvedThinkingLevel: "medium",
				},
			},
			{ id: "b", status: "running", startedAt: 2, extra: { resolvedModel: "openai/gpt-5:low" } },
			{ id: "c", status: "running", startedAt: 3 },
		]);
		expect(subagentById("a")?.model).toEqual({
			id: "claude-sonnet-5-5",
			identity: "anthropic/claude-sonnet-5-5",
			thinking: "medium",
		});
		expect(subagentById("b")?.model).toEqual({
			id: "gpt-5",
			identity: "openai/gpt-5",
			thinking: "low",
		});
		expect(subagentById("c")?.model).toBeUndefined();
	});

	test("live line follows the precedence and exists only while running", () => {
		seed([
			{
				id: "cur",
				status: "running",
				startedAt: 1,
				extra: {
					currentTool: "bash",
					currentToolIntent: "Run tests",
					lastTool: { tool: "read", intent: "Read file" },
					lastIntent: "Thinking",
				},
			},
			{
				id: "last",
				status: "running",
				startedAt: 2,
				extra: {
					lastTool: { tool: "read", intent: "Read file", isError: true },
					lastIntent: "Thinking",
				},
			},
			{ id: "intent", status: "running", startedAt: 3, extra: { lastIntent: "Thinking" } },
			{ id: "none", status: "running", startedAt: 4 },
			{
				id: "done",
				status: "completed",
				startedAt: 5,
				endedAt: 6,
				extra: { lastIntent: "Thinking" },
			},
		]);
		expect(subagentById("cur")?.live).toEqual({ tool: "bash", intent: "Run tests" });
		expect(subagentById("last")?.live).toEqual({
			tool: "read",
			intent: "Read file",
			isError: true,
		});
		expect(subagentById("intent")?.live).toEqual({ intent: "Thinking" });
		expect(subagentById("none")?.live).toBeUndefined();
		expect(subagentById("done")?.live).toBeUndefined();
	});

	test("completion estimate exists only while running, and keeps a zero", () => {
		seed([
			{
				id: "mid",
				status: "running",
				startedAt: 1,
				extra: { completionPercent: 40, stage: "Writing tests" },
			},
			{ id: "zero", status: "running", startedAt: 2, extra: { completionPercent: 0 } },
			{ id: "silent", status: "running", startedAt: 3 },
			{
				id: "done",
				status: "completed",
				startedAt: 4,
				endedAt: 5,
				extra: { completionPercent: 99 },
			},
		]);
		expect(subagentById("mid")?.completionPercent).toBe(40);
		expect(subagentById("mid")?.live?.stage).toBe("Writing tests");
		expect(subagentById("zero")?.completionPercent).toBe(0);
		expect(subagentById("silent")?.completionPercent).toBeUndefined();
		expect(subagentById("done")?.completionPercent).toBeUndefined();
		expect(subagentEstimate("mid")).toEqual({ percent: 40, stage: "Writing tests" });
		expect(subagentEstimate("zero")).toEqual({ percent: 0, stage: undefined });
		expect(subagentEstimate("silent")).toBeUndefined();
		expect(subagentEstimate("done")).toBeUndefined();
		expect(subagentEstimate("missing")).toBeUndefined();
	});
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

	test("roster-only finished agent keeps its retained usage; unknown usage stays undefined, not 0", () => {
		const records: Record<string, WorkerRecord> = {
			[workerKey(SESSION, "done")]: {
				id: "done",
				agentId: "done",
				sessionId: SESSION,
				displayName: "task",
				status: "completed",
				usage: { tokens: 1200, requests: 3, cost: 0.02 },
				lastActivity: 5,
				createdAt: 1,
				revivable: false,
			} as WorkerRecord,
			[workerKey(SESSION, "legacy")]: {
				id: "legacy",
				agentId: "legacy",
				sessionId: SESSION,
				displayName: "task",
				status: "completed",
				lastActivity: 5,
				createdAt: 2,
				revivable: false,
			} as WorkerRecord,
		};
		setState("workers", { ...createWorkersState(), records, order: Object.keys(records) });
		const forest = subagentForest();
		const done = forest.find((node) => node.id === "done");
		const legacy = forest.find((node) => node.id === "legacy");
		expect(done?.metrics.tokens).toBe(1200);
		expect(done?.metrics.cost).toBe(0.02);
		expect(legacy?.metrics.tokens).toBeUndefined();
		expect(legacy?.metrics.cost).toBeUndefined();
	});

	test("a finished roster-only agent measures elapsed to its last activity, not to now", () => {
		setState("subagents", new Map<string, SubagentInfo>());
		const key = workerKey(SESSION, "r");
		setState("workers", {
			...createWorkersState(),
			records: {
				[key]: {
					id: "r",
					agentId: "r",
					sessionId: SESSION,
					key,
					displayName: "task",
					status: "completed",
					lastActivity: 4_000,
					createdAt: 1_000,
					revivable: false,
				} as WorkerRecord,
			},
			order: [key],
		});
		const [node] = subagentForest();
		expect(node?.endedAt).toBe(4_000);
		expect(node?.metrics.elapsedMs).toBe(3_000);
	});

	test("a parked roster-only agent is not running, so its elapsed stops at its last activity", () => {
		setState("subagents", new Map<string, SubagentInfo>());
		const key = workerKey(SESSION, "p");
		setState("workers", {
			...createWorkersState(),
			records: {
				[key]: {
					id: "p",
					agentId: "p",
					sessionId: SESSION,
					key,
					displayName: "task",
					status: "parked",
					lastActivity: 4_000,
					createdAt: 1_000,
					revivable: true,
				} as WorkerRecord,
			},
			order: [key],
		});
		const [node] = subagentForest();
		expect(node?.endedAt).toBe(4_000);
		expect(node?.metrics.elapsedMs).toBe(3_000);
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

describe("runningSubagentCount, subagentScopeCounts and subagentById", () => {
	test("counts running and pending agents at every depth", () => {
		seed([
			{ id: "p", status: "running", startedAt: 1 },
			{ id: "c", status: "running", parent: "p", startedAt: 2 },
			{ id: "q", status: "pending", parent: "p" },
			{ id: "d", status: "done", startedAt: 3, endedAt: 4 },
		]);
		expect(runningSubagentCount()).toBe(3);
	});

	test("scope counts cover every depth, a roster park included", () => {
		seed([
			{ id: "p", status: "running", startedAt: 1 },
			{ id: "c", status: "failed", parent: "p", startedAt: 2, endedAt: 3 },
			{ id: "q", status: "pending", parent: "c" },
			{ id: "d", status: "done", startedAt: 3, endedAt: 4 },
			{ id: "z", status: "done", lastUpdate: 100, rosterStatus: "parked", rosterActivity: 200 },
			{ id: "x", status: "aborted", parent: "d" },
		]);
		expect(subagentScopeCounts()).toEqual({ all: 6, running: 2, done: 2, parked: 1 });
		expect(runningSubagentCount()).toBe(subagentScopeCounts().running);
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

	test("an aborted agent can be revived only when the roster says it is revivable", () => {
		seed([{ id: "a", status: "aborted", startedAt: 1, endedAt: 2, revivable: true }]);
		expect(subagentCapabilities("a")).toEqual({
			steer: false,
			abort: false,
			park: false,
			revive: true,
		});
		seed([{ id: "a", status: "aborted", startedAt: 1, endedAt: 2, revivable: false }]);
		expect(subagentCapabilities("a").revive).toBe(false);
	});

	test("a revivable verdict never revives an agent that is not parked or aborted", () => {
		seed([{ id: "a", status: "done", startedAt: 1, endedAt: 2, revivable: true }]);
		expect(subagentCapabilities("a").revive).toBe(false);
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
