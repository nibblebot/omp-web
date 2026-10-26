/**
 * What the status line, popovers and panel count (activities/summary.ts): task jobs belong to
 * Subagents, daemons are the ones this workspace's session reported, todos count done/total.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { daemonsKey, type DaemonInfo, type JobDto, type JobTreeRowDto } from "#lib/wire/protocol";
import type { SubagentInfo } from "../../state";

// The shared job poll is replaced by a settable answer; the summary is imported after the mock so it binds to it.
import type { JobPollView } from "../../store/job-poll";
const realJobPoll = await import("../../store/job-poll");
const originalJobPoll = { ...realJobPoll };
let pollRows: JobTreeRowDto[] = [];
mock.module("../../store/job-poll", () => ({
	...originalJobPoll,
	jobPollView: (): JobPollView => ({ phase: "ready", tree: { rows: pollRows }, at: 1 }),
	jobTreeRows: () => pollRows,
}));
afterAll(() => {
	mock.module("../../store/job-poll", () => originalJobPoll);
});

const { setState, state } = await import("../../state");
const {
	activityDaemons,
	activityJobRows,
	daemonsSummary,
	jobsSummary,
	subagentsSummary,
	todosSummary,
} = await import("../../activities/summary");

const place = { depth: 0, rails: [] as boolean[], last: true, parent: false };
const jobRow = (id: string, type: string, status: JobDto["status"]): JobTreeRowDto => ({
	...place,
	kind: "job",
	job: { id, type, status, label: id, startTime: 1, own: true },
});

function daemon(name: string, patch: Partial<DaemonInfo> = {}): DaemonInfo {
	return {
		name,
		id: `id-${name}`,
		projectDir: "/p",
		state: "running",
		createdAt: 0,
		startedAt: 0,
		restartCount: 0,
		persist: false,
		detached: false,
		reportedBy: ["d1"],
		...patch,
	};
}

function seedDaemons(...list: DaemonInfo[]): void {
	setState("daemons", new Map(list.map((d) => [daemonsKey(d), d])));
}

function subagent(id: string, status: string): [string, SubagentInfo] {
	return [id, { id, index: 0, agent: "task", status, lastUpdate: 0 } as SubagentInfo];
}

let saved: Pick<typeof state, "currentWorkspaceId" | "subagents" | "daemons" | "todoPhases">;

beforeEach(() => {
	saved = {
		currentWorkspaceId: state.currentWorkspaceId,
		subagents: state.subagents,
		daemons: state.daemons,
		todoPhases: state.todoPhases,
	};
	setState({ currentWorkspaceId: "d1" });
	pollRows = [];
});

afterEach(() => {
	setState(saved);
});

describe("subagentsSummary", () => {
	test("counts every subagent; running and pending are active", () => {
		setState(
			"subagents",
			new Map([
				subagent("a1", "running"),
				subagent("a2", "pending"),
				subagent("a3", "done"),
				subagent("a4", "failed"),
			]),
		);
		expect(subagentsSummary()).toEqual({ total: 4, active: 2, settled: false });
	});

	test("all finished is settled; none at all is not", () => {
		setState("subagents", new Map([subagent("a1", "done"), subagent("a2", "aborted")]));
		expect(subagentsSummary()).toEqual({ total: 2, active: 0, settled: true });
		setState("subagents", new Map());
		expect(subagentsSummary()).toEqual({ total: 0, active: 0, settled: false });
	});
});

describe("jobs", () => {
	test("task jobs are subagents, not Jobs rows", () => {
		pollRows = [
			jobRow("j1", "bash", "running"),
			jobRow("t1", "task", "running"),
			jobRow("j2", "eval", "completed"),
			{ ...place, kind: "agent", agent: { id: "a1" } as never },
		];
		expect(activityJobRows().map((row) => row.job.id)).toEqual(["j1", "j2"]);
		expect(jobsSummary()).toEqual({ total: 2, active: 1, settled: false });
	});

	test("only running jobs are active; finished, failed and cancelled settle the section", () => {
		pollRows = [
			jobRow("j1", "bash", "completed"),
			jobRow("j2", "bash", "failed"),
			jobRow("j3", "bash", "cancelled"),
		];
		expect(jobsSummary()).toEqual({ total: 3, active: 0, settled: true });
	});

	test("no jobs is an empty, unsettled section", () => {
		expect(jobsSummary()).toEqual({ total: 0, active: 0, settled: false });
	});
});

describe("daemons", () => {
	test("only live daemons this workspace's session reported, oldest first", () => {
		seedDaemons(
			daemon("late", { startedAt: 30 }),
			daemon("early", { startedAt: 10 }),
			daemon("other", { reportedBy: ["d2"] }),
			daemon("unattributed", { reportedBy: undefined }),
			daemon("dead", { state: "exited" }),
		);
		expect(activityDaemons().map((d) => d.name)).toEqual(["early", "late"]);
	});

	test("starting, running, ready and restarting are active; stopping is not", () => {
		seedDaemons(
			daemon("a", { state: "starting" }),
			daemon("b", { state: "ready" }),
			daemon("c", { state: "restarting" }),
			daemon("d", { state: "stopping" }),
		);
		expect(daemonsSummary()).toEqual({ total: 4, active: 3, settled: false });
		seedDaemons(daemon("d", { state: "stopping" }));
		expect(daemonsSummary()).toEqual({ total: 1, active: 0, settled: true });
	});

	test("a switch to another workspace re-filters", () => {
		seedDaemons(daemon("mine"));
		expect(daemonsSummary().total).toBe(1);
		setState("currentWorkspaceId", "d2");
		expect(daemonsSummary().total).toBe(0);
	});
});

describe("todosSummary", () => {
	const phases = (...statuses: string[][]) =>
		statuses.map((tasks, i) => ({
			name: `p${i}`,
			tasks: tasks.map((status, j) => ({ content: `t${i}.${j}`, status })),
		})) as never;

	test("completed and abandoned count as done across phases", () => {
		setState(
			"todoPhases",
			phases(["completed", "in_progress", "pending"], ["abandoned", "blocked"]),
		);
		expect(todosSummary()).toEqual({ total: 5, done: 2, settled: false });
	});

	test("everything done settles; no todos does not", () => {
		setState("todoPhases", phases(["completed", "abandoned"]));
		expect(todosSummary()).toEqual({ total: 2, done: 2, settled: true });
		setState("todoPhases", []);
		expect(todosSummary()).toEqual({ total: 0, done: 0, settled: false });
	});
});
