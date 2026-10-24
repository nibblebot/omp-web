import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { JobDetailDto, JobDto, JobTreeDto } from "#lib/wire/protocol";
import * as transport from "../../store/transport";

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
const { setState, state } = await import("../../state");
const originalSession = state.currentSessionId;

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

let stop: (() => void) | undefined;
beforeEach(() => {
	stop?.();
	stop = undefined;
	calls = [];
	setState("currentSessionId", "sess-a");
	jobs.selectJob(null);
});
afterAll(() => {
	stop?.();
	setState("currentSessionId", originalSession);
});

describe("jobs tree", () => {
	test("loads the session's job tree and reports when the session has no job manager", async () => {
		answer({ getJobTree: treeOf(job("a"), job("b", { status: "completed", endTime: 4000 })) });
		expect(jobs.jobsView()).toBe("loading");
		await jobs.refreshJobs();
		expect(jobs.jobsView()).toBe("ready");
		expect(jobs.jobList().map((j) => j.id)).toEqual(["a", "b"]);

		answer({ getJobTree: null });
		await jobs.refreshJobs();
		expect(jobs.jobsView()).toBe("unavailable");
		expect(jobs.jobRows()).toEqual([]);
	});

	test("an answer for a session the page has left never shows", async () => {
		const pending = held<JobTreeDto>();
		handler = () => pending.promise;
		const refreshing = jobs.refreshJobs();
		setState("currentSessionId", "sess-b");
		pending.resolve(treeOf(job("old")));
		await refreshing;
		expect(jobs.jobsView()).toBe("loading");
		expect(jobs.jobList()).toEqual([]);
	});

	test("overlapping refreshes share one request", async () => {
		answer({ getJobTree: treeOf(job("a")) });
		await Promise.all([jobs.refreshJobs(), jobs.refreshJobs(), jobs.refreshJobs()]);
		expect(calls.filter((c) => c.method === "getJobTree")).toHaveLength(1);
	});

	test("a failed refresh shows its error and the next good one clears it", async () => {
		answer({ getJobTree: new Error("socket closed") });
		await jobs.refreshJobs();
		expect(jobs.jobsError()).toBe("socket closed");
		answer({ getJobTree: treeOf(job("a")) });
		await jobs.refreshJobs();
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

describe("selected job", () => {
	const detail: JobDetailDto = { pids: [42], command: "sleep 9", output: "tick" };

	test("selecting a job fetches its inspection, and each refresh updates it", async () => {
		answer({ getJobTree: treeOf(job("a")), getJobDetail: detail });
		await jobs.refreshJobs();
		jobs.selectJob("a");
		expect(jobs.selectedJobDetail()).toBeUndefined();
		await settle();
		expect(calls.at(-1)).toEqual({ method: "getJobDetail", args: ["a"] });
		expect(jobs.selectedJobDetail()).toEqual(detail);

		answer({ getJobTree: treeOf(job("a")), getJobDetail: { ...detail, output: "tock" } });
		await jobs.refreshJobs();
		expect(jobs.selectedJobDetail()?.output).toBe("tock");
	});

	test("a job that leaves the list drops the selection", async () => {
		answer({ getJobTree: treeOf(job("a")), getJobDetail: detail });
		await jobs.refreshJobs();
		jobs.selectJob("a");
		await settle();
		answer({ getJobTree: treeOf(job("b")) });
		await jobs.refreshJobs();
		expect(jobs.selectedJobId()).toBeNull();
		expect(jobs.selectedJob()).toBeUndefined();
	});

	test("a job the daemon no longer inspects reads as gone", async () => {
		answer({ getJobTree: treeOf(job("a")), getJobDetail: null });
		await jobs.refreshJobs();
		jobs.selectJob("a");
		await settle();
		expect(jobs.selectedJobDetail()).toBeNull();
	});
});

describe("cancelling an own job", () => {
	test("asks the daemon, marks the job busy meanwhile, and reloads the tree", async () => {
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
		await jobs.refreshJobs();
		const cancel = jobs.cancelOwnJob("a");
		expect(jobs.cancellingJobId()).toBe("a");
		cancelling.resolve(undefined);
		await cancel;
		expect(jobs.cancellingJobId()).toBeNull();
		expect(calls.map((c) => c.method)).toEqual(["getJobTree", "cancelJob", "getJobTree"]);
		expect(jobs.jobList()[0]?.status).toBe("cancelled");
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
		expect(jobs.jobList().map((j) => j.id)).toEqual(["a"]);

		answer({ getJobTree: treeOf(job("a")), cancelJob: { cancelled: true } });
		await jobs.cancelOwnJob("a");
		expect(jobs.jobCancelError()).toBeNull();
	});
});

describe("polling", () => {
	test("loads at once, and stopping forgets the tree, selection and errors", async () => {
		answer({ getJobTree: treeOf(job("a")), getJobDetail: { pids: [] } });
		stop = jobs.startJobsPolling();
		await settle();
		expect(jobs.jobsView()).toBe("ready");
		jobs.selectJob("a");
		stop();
		stop = undefined;
		expect(jobs.jobsView()).toBe("loading");
		expect(jobs.selectedJobId()).toBeNull();
		expect(jobs.jobsError()).toBeNull();
	});
});
