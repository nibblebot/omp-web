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
const poll = await import("../../store/job-poll");
const { clearJobWidgets } = await import("../../store/job-widgets");
const { setState, state } = await import("../../state");
const originalSession = state.currentWorkspaceId;
const originalConnected = state.connected;
const originalModal = state.modal;

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
beforeEach(async () => {
	stop?.();
	stop = undefined;
	calls = [];
	// Detach, then attach: the previous test's tree and poll state are gone, and the poll itself stays
	// quiet (the connection is down) so only the calls a test makes show.
	setState("connected", false);
	setState("currentWorkspaceId", "");
	clearJobWidgets();
	await settle();
	setState("currentWorkspaceId", "sess-a");
	jobs.selectJob(null);
});
afterAll(() => {
	stop?.();
	setState("currentWorkspaceId", originalSession);
	setState("connected", originalConnected);
	setState("modal", originalModal);
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
		setState("currentWorkspaceId", "sess-b");
		pending.resolve(treeOf(job("old")));
		await refreshing;
		expect(jobs.jobsView()).toBe("loading");
		expect(jobs.jobList()).toEqual([]);
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

	test("a job the session no longer inspects reads as gone", async () => {
		answer({ getJobTree: treeOf(job("a")), getJobDetail: null });
		await jobs.refreshJobs();
		jobs.selectJob("a");
		await settle();
		expect(jobs.selectedJobDetail()).toBeNull();
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
	test("loads at once, and stopping forgets the selection and errors but not the shared tree", async () => {
		answer({ getJobTree: treeOf(job("a")), getJobDetail: { pids: [] } });
		stop = jobs.startJobsPolling();
		await settle();
		expect(jobs.jobsView()).toBe("ready");
		jobs.selectJob("a");
		stop();
		stop = undefined;
		expect(jobs.selectedJobId()).toBeNull();
		expect(jobs.jobsError()).toBeNull();
		expect(poll.jobPollView().phase).toBe("ready");
	});
});

describe("opening the sheet", () => {
	const detail: JobDetailDto = { pids: [], command: "sleep 9", output: "tick" };

	test("opens the modal, and with a job preselects it once the tree lists it", async () => {
		answer({ getJobTree: treeOf(job("a"), job("b")), getJobDetail: detail });
		setState("modal", null);
		jobs.openJobsSheet("b");
		expect(state.modal).toBe("jobs");
		expect(jobs.selectedJobId()).toBe("b");
		await settle();
		expect(jobs.selectedJobDetail()).toEqual(detail);

		// The sheet's polling then loads the tree: the row exists and stays selected.
		stop = jobs.startJobsPolling();
		await settle();
		expect(jobs.selectedJob()?.id).toBe("b");
		expect(jobs.selectedJobId()).toBe("b");
	});

	test("without a job it only opens the modal and leaves the selection alone", () => {
		answer({ getJobTree: treeOf(job("a")), getJobDetail: detail });
		setState("modal", null);
		jobs.selectJob("a");
		jobs.openJobsSheet();
		expect(state.modal).toBe("jobs");
		expect(jobs.selectedJobId()).toBe("a");
	});

	test("an open sheet switches to the asked job", async () => {
		answer({ getJobTree: treeOf(job("a"), job("b")), getJobDetail: detail });
		stop = jobs.startJobsPolling();
		await settle();
		jobs.selectJob("a");
		jobs.openJobsSheet("b");
		await settle();
		expect(jobs.selectedJobId()).toBe("b");
		expect(jobs.selectedJob()?.id).toBe("b");
	});

	test("a job the tree no longer lists ends up unselected", async () => {
		answer({ getJobTree: treeOf(job("a")), getJobDetail: null });
		jobs.openJobsSheet("gone");
		await jobs.refreshJobs();
		expect(jobs.selectedJobId()).toBeNull();
	});

	test("a tree requested before the selection cannot drop it", async () => {
		const pending = held<JobTreeDto>();
		handler = () => pending.promise;
		const refreshing = jobs.refreshJobs();
		jobs.openJobsSheet("late");
		pending.resolve(treeOf(job("a")));
		await refreshing;
		expect(jobs.selectedJobId()).toBe("late");
	});
});

describe("fetching one job's detail", () => {
	const detail: JobDetailDto = { pids: [], command: "make", output: "ok" };

	test("returns the inspection without touching the sheet's selection", async () => {
		answer({ getJobDetail: detail });
		jobs.selectJob(null);
		expect(await jobs.fetchJobDetail("a")).toEqual(detail);
		expect(calls.at(-1)).toEqual({ method: "getJobDetail", args: ["a"] });
		expect(jobs.selectedJobId()).toBeNull();
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
