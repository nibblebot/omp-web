import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { JobDetailDto, JobDto, JobTreeDto } from "#lib/wire/protocol";
import * as transport from "../../store/transport";
import { installLocalStorageShim, restoreBrowserGlobals } from "../web.testkit";

// The transport is mocked per test; the store module is imported after the mock so it binds to it.
let handler: (method: string, args: unknown[]) => Promise<unknown> = async () => undefined;
const originalTransport = { ...transport };
mock.module("../../store/transport", () => ({
	...originalTransport,
	call: (method: string, args: unknown[]) => handler(method, args),
}));

afterAll(() => {
	// mock.restore() leaves module mocks installed; reinstall the real exports for later files.
	mock.module("../../store/transport", () => originalTransport);
});

// Dynamic imports: the transport mock must be registered before the store module binds to it.
const jobs = await import("../../store/jobs");
const activities = await import("../../store/activities");
const { restoreDockLayout } = await import("../../store/dock");
const poll = await import("../../store/job-poll");
const { clearJobWidgets } = await import("../../store/job-widgets");
const { setState, state } = await import("../../state");
const originalSession = state.currentWorkspaceId;
const originalConnected = state.connected;

const place = { depth: 0, rails: [] as boolean[], last: true, parent: false };
const job = (id: string, over: Partial<JobDto> = {}): JobDto => ({
	id,
	type: "bash",
	status: "running",
	label: id,
	startTime: 1000,
	ownerId: "Main",
	own: true,
	...over,
});
const treeOf = (...list: JobDto[]): JobTreeDto => ({
	rootId: "Main",
	rows: list.map((j) => ({ ...place, kind: "job" as const, job: j })),
});
const settle = async () => {
	for (let i = 0; i < 20; i++) await Promise.resolve();
};
/** A call the test settles by hand. */
const held = <T>() => Promise.withResolvers<T>();

let calls: Array<{ method: string; args: unknown[] }> = [];
const answer = (answers: Record<string, unknown>) => {
	handler = async (method, args) => {
		calls.push({ method, args });
		const value = answers[method];
		if (value instanceof Error) throw value;
		return value;
	};
};

const releases: Array<() => void> = [];
const watch = (jobId: string) => {
	const release = jobs.watchJobDetail(jobId);
	releases.push(release);
	return release;
};
beforeEach(async () => {
	for (const release of releases.splice(0)) release();
	calls = [];
	// Detach, then attach: the previous test's tree and poll state are gone, and the poll itself stays
	// quiet (the connection is down) so only the calls a test makes show.
	setState("connected", false);
	setState("currentWorkspaceId", "");
	clearJobWidgets();
	await settle();
	setState("currentWorkspaceId", "sess-a");
});
afterAll(async () => {
	for (const release of releases.splice(0)) release();
	// Detach so the poll drops the re-armed timer the file's refreshes left behind, then hand the state back.
	setState("currentWorkspaceId", "");
	clearJobWidgets();
	await settle();
	setState("currentWorkspaceId", originalSession);
	setState("connected", originalConnected);
});

describe("jobs tree", () => {
	test("a failed poll shows its error and the next good one clears it", async () => {
		answer({ getJobTree: new Error("socket closed") });
		await poll.refreshJobTree();
		expect(jobs.jobsError()).toBe("socket closed");
		answer({ getJobTree: treeOf(job("a")) });
		await poll.refreshJobTree();
		expect(jobs.jobsError()).toBeNull();
	});

	test("run time counts up while running and freezes once settled", () => {
		expect(jobs.jobElapsedMs(job("a", { startTime: 1000 }), 6000)).toBe(5000);
		expect(
			jobs.jobElapsedMs(job("a", { status: "failed", startTime: 1000, endTime: 3000 }), 60_000),
		).toBe(2000);
		expect(jobs.jobElapsedMs(job("a", { status: "cancelled" }), 60_000)).toBeUndefined();
	});
});

describe("a watched job's detail", () => {
	const detail: JobDetailDto = { pids: [42], command: "sleep 9", output: "tick" };
	const detailCalls = () => calls.filter((c) => c.method === "getJobDetail").length;

	test("loads at once and reloads with each tree answer while the job runs", async () => {
		answer({ getJobTree: treeOf(job("a")), getJobDetail: detail });
		await poll.refreshJobTree();
		watch("a");
		expect(jobs.jobDetailOf("a")).toBeUndefined();
		await settle();
		expect(calls.at(-1)).toEqual({ method: "getJobDetail", args: ["a"] });
		expect(jobs.jobDetailOf("a")).toEqual(detail);

		answer({ getJobTree: treeOf(job("a")), getJobDetail: { ...detail, output: "tock" } });
		await poll.refreshJobTree();
		expect(jobs.jobDetailOf("a")?.output).toBe("tock");
	});

	test("a job that settles is read once more, then left alone", async () => {
		answer({ getJobTree: treeOf(job("a")), getJobDetail: detail });
		await poll.refreshJobTree();
		watch("a");
		await settle();
		const done = job("a", { status: "completed", endTime: 3000 });
		answer({ getJobTree: treeOf(done), getJobDetail: { ...detail, exitCode: 0, output: "bye" } });
		await poll.refreshJobTree();
		expect(jobs.jobDetailOf("a")?.output).toBe("bye");

		const before = detailCalls();
		await poll.refreshJobTree();
		expect(detailCalls()).toBe(before);
	});

	test("a job the session no longer inspects reads as gone", async () => {
		answer({ getJobTree: treeOf(job("a")), getJobDetail: null });
		await poll.refreshJobTree();
		watch("a");
		await settle();
		expect(jobs.jobDetailOf("a")).toBeNull();
	});

	test("a job the tree does not list yet keeps what it has, so a poll asked before it started cannot drop it", async () => {
		answer({ getJobTree: treeOf(job("other")), getJobDetail: detail });
		await poll.refreshJobTree();
		watch("a");
		await settle();
		const before = detailCalls();
		await poll.refreshJobTree();
		expect(detailCalls()).toBe(before);
		expect(jobs.jobDetailOf("a")).toEqual(detail);
	});

	test("two surfaces share one fetch, and the last release forgets the job", async () => {
		answer({ getJobTree: treeOf(job("a")), getJobDetail: detail });
		await poll.refreshJobTree();
		const first = watch("a");
		const second = watch("a");
		await settle();
		expect(detailCalls()).toBe(1);
		first();
		first();
		expect(jobs.jobDetailOf("a")).toEqual(detail);
		second();
		expect(jobs.jobDetailOf("a")).toBeUndefined();
	});

	test("a detail asked for another workspace never shows", async () => {
		const pending = held<JobDetailDto>();
		handler = () => pending.promise;
		watch("a");
		setState("currentWorkspaceId", "sess-b");
		pending.resolve(detail);
		await settle();
		expect(jobs.jobDetailOf("a")).toBeUndefined();
	});

	test("a failed read shows its error, and the next good one clears it", async () => {
		answer({ getJobTree: treeOf(job("a")), getJobDetail: new Error("session busy") });
		await poll.refreshJobTree();
		watch("a");
		await settle();
		expect(jobs.jobsError()).toBe("session busy");
		answer({ getJobTree: treeOf(job("a")), getJobDetail: detail });
		await poll.refreshJobTree();
		expect(jobs.jobsError()).toBeNull();
	});
});

describe("cancelling an own job", () => {
	test("asks the session, marks the job busy meanwhile, and reloads the tree", async () => {
		const cancelling = held<unknown>();
		const running = treeOf(job("a"));
		const settled = treeOf(job("a", { status: "cancelled", endTime: 3000 }));
		let tree = running;
		handler = async (method, args) => {
			calls.push({ method, args });
			if (method === "cancelJob") {
				await cancelling.promise;
				tree = settled;
				return { cancelled: true };
			}
			return tree;
		};
		await poll.refreshJobTree();
		const cancel = jobs.cancelOwnJob("a");
		expect(jobs.cancellingJobId()).toBe("a");
		cancelling.resolve(undefined);
		await cancel;
		expect(jobs.cancellingJobId()).toBeNull();
		expect(calls.map((c) => c.method)).toEqual(["getJobTree", "cancelJob", "getJobTree"]);
		expect(poll.jobTreeRows()[0]).toMatchObject({ job: { status: "cancelled" } });
	});

	test("a tree request already in flight when the cancel lands does not stand for the reload", async () => {
		const stale = held<JobTreeDto>();
		let tree = treeOf(job("a"));
		let first = true;
		handler = async (method, args) => {
			calls.push({ method, args });
			if (method === "cancelJob") {
				tree = treeOf(job("a", { status: "cancelled", endTime: 3000 }));
				return { cancelled: true };
			}
			if (first) {
				first = false;
				return stale.promise;
			}
			return tree;
		};
		const inFlight = poll.refreshJobTree();
		const cancel = jobs.cancelOwnJob("a");
		await settle();
		stale.resolve(treeOf(job("a")));
		await Promise.all([inFlight, cancel]);
		expect(poll.jobTreeRows()[0]).toMatchObject({ job: { status: "cancelled" } });
	});

	test("a refusal shows until the next cancel, and the tree still reloads", async () => {
		answer({
			getJobTree: treeOf(job("a")),
			cancelJob: new Error(
				"Job a belongs to Explorer; only this session's own jobs can be cancelled",
			),
		});
		await jobs.cancelOwnJob("a");
		expect(jobs.jobCancelError()).toContain("belongs to Explorer");
		expect(jobs.jobsError()).toBeNull();
		expect(poll.jobTreeRows()).toHaveLength(1);

		answer({ getJobTree: treeOf(job("a")), cancelJob: { cancelled: true } });
		await jobs.cancelOwnJob("a");
		expect(jobs.jobCancelError()).toBeNull();
	});

	test("the surface that showed a refusal can clear it", async () => {
		answer({ getJobTree: treeOf(job("a")), cancelJob: new Error("refused") });
		await jobs.cancelOwnJob("a");
		jobs.clearJobCancelError();
		expect(jobs.jobCancelError()).toBeNull();
	});
});

describe("fetching one job's detail", () => {
	const detail: JobDetailDto = { pids: [], command: "make", output: "ok" };

	test("returns the inspection without watching the job", async () => {
		answer({ getJobDetail: detail });
		expect(await jobs.fetchJobDetail("a")).toEqual(detail);
		expect(calls.at(-1)).toEqual({ method: "getJobDetail", args: ["a"] });
		expect(jobs.jobDetailOf("a")).toBeUndefined();
	});

	test("is null when the session no longer knows the job or the call fails", async () => {
		answer({ getJobDetail: null });
		expect(await jobs.fetchJobDetail("a")).toBeNull();
		answer({ getJobDetail: new Error("socket closed") });
		expect(await jobs.fetchJobDetail("a")).toBeNull();
		expect(jobs.jobsError()).toBeNull();
	});

	test("is null when the session changed while it was in flight", async () => {
		const pending = held<JobDetailDto>();
		handler = () => pending.promise;
		const fetching = jobs.fetchJobDetail("a");
		setState("currentWorkspaceId", "sess-b");
		pending.resolve(detail);
		expect(await fetching).toBeNull();
	});
});

describe("opening a job from outside the panel", () => {
	beforeEach(() => {
		installLocalStorageShim();
		restoreDockLayout("__no-such-workspace__");
	});
	afterEach(() => {
		restoreDockLayout("__no-such-workspace__");
		restoreBrowserGlobals();
	});

	test("a wait card's job opens the panel on that job, in the saved mode", async () => {
		answer({ getJobTree: treeOf(job("a"), job("b")), getJobDetail: { pids: [] } });
		await poll.refreshJobTree();
		activities.openActivities({ section: "jobs", item: { section: "jobs", id: "b" } });
		expect(state.dock?.kind).toBe("activities");
		expect(state.activities.expanded.jobs.has("b")).toBe(true);
		expect(state.activities.expanded.jobs.has("a")).toBe(false);
		expect(state.activities.focusRequest?.target).toEqual({ section: "jobs", id: "b" });

		activities.setActivitiesMode("detail");
		activities.openActivities({ section: "jobs", item: { section: "jobs", id: "a" } });
		expect(state.activities.detail).toEqual({ section: "jobs", id: "a" });
	});

	test("a wait card's overflow control opens the Jobs section without choosing a job", () => {
		activities.openActivities({ section: "jobs" });
		expect(state.dock?.kind).toBe("activities");
		expect(state.activities.focusRequest?.target).toBe("jobs");
		expect(state.activities.detail).toBeUndefined();
	});
});
