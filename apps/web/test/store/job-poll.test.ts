/**
 * The shared job tree poll: it asks only while a workspace is attached and the page is visible, paces
 * itself by whether a surface holds focus, re-asks when the running count changes, and never shows the
 * answer of a workspace the tab has left.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test, vi } from "bun:test";
import type { JobDto, JobTreeDto } from "#lib/wire/protocol";
import * as transport from "../../store/transport";

// The transport is mocked per test; the store modules are imported after the mock so they bind to it.
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

// Dynamic imports: the transport mock must be registered before the store modules bind to it.
const poll = await import("../../store/job-poll");
const { applyJobWidgets, clearJobWidgets } = await import("../../store/job-widgets");
const { setState, state } = await import("../../state");
const original = { workspaceId: state.currentWorkspaceId, connected: state.connected };
const originalDocument = Reflect.get(globalThis, "document");

const place = { depth: 0, rails: [] as boolean[], last: true, parent: false };
const job = (id: string): JobDto => ({
	id,
	type: "bash",
	status: "running",
	label: id,
	startTime: 1000,
	ownerId: "Main",
	own: true,
});
const treeOf = (...list: JobDto[]): JobTreeDto => ({
	rootId: "Main",
	rows: list.map((j) => ({ ...place, kind: "job" as const, job: j })),
});
const settle = async () => {
	for (let i = 0; i < 20; i++) await Promise.resolve();
};
/** Run the clock `ms` forward, letting each answer land. */
const elapse = async (ms: number) => {
	vi.advanceTimersByTime(ms);
	await settle();
};

let calls = 0;
let tree = treeOf(job("a"));
const answerWith = (next: JobTreeDto | null) => {
	handler = async () => {
		calls++;
		return next;
	};
};

/** Bun's test env has no DOM: a stand-in with the two members the poll reads. */
let visibility: "visible" | "hidden" = "visible";
let visibilityListeners: Array<() => void> = [];
const fakeDocument = () => ({
	get visibilityState() {
		return visibility;
	},
	addEventListener: (_type: string, listener: () => void) => {
		visibilityListeners.push(listener);
	},
});
const setVisibility = async (next: "visible" | "hidden") => {
	visibility = next;
	for (const listener of visibilityListeners) listener();
	await settle();
};

/** An `attached` frame for `workspaceId`: the id lands, then the attach reset restarts the poll. */
const attach = async (workspaceId: string) => {
	setState("currentWorkspaceId", workspaceId);
	clearJobWidgets();
	await settle();
};

let release: (() => void) | undefined;
beforeEach(async () => {
	vi.useFakeTimers();
	visibility = "visible";
	visibilityListeners = [];
	Reflect.set(globalThis, "document", fakeDocument());
	calls = 0;
	tree = treeOf(job("a"));
	answerWith(tree);
	setState("connected", true);
	// Detach: any previous test's answer, focus and timer are gone.
	release?.();
	release = undefined;
	setState("currentWorkspaceId", "");
	clearJobWidgets();
	await settle();
	calls = 0;
});
afterEach(() => {
	release?.();
	release = undefined;
	setState("currentWorkspaceId", "");
	clearJobWidgets();
	vi.useRealTimers();
	Reflect.set(globalThis, "document", originalDocument);
});
afterAll(() => {
	setState("currentWorkspaceId", original.workspaceId);
	setState("connected", original.connected);
});

describe("when it runs", () => {
	test("asks at once on attach, then keeps the snapshot", async () => {
		expect(poll.jobPollView()).toEqual({ phase: "idle" });
		await attach("sess-a");
		expect(calls).toBe(1);
		const view = poll.jobPollView();
		expect(view).toMatchObject({ phase: "ready", tree });
		expect(poll.jobTreeRows()).toEqual(tree.rows);
	});

	test("reads unavailable when the session has no job manager", async () => {
		answerWith(null);
		await attach("sess-a");
		expect(poll.jobPollView()).toEqual({ phase: "unavailable" });
		expect(poll.jobTreeRows()).toEqual([]);
	});

	test("never asks while no workspace is attached", async () => {
		release = poll.acquireJobPollFocus();
		await elapse(60_000);
		expect(calls).toBe(0);
		expect(poll.jobPollView()).toEqual({ phase: "idle" });
	});

	test("never asks while the connection is down, and resumes at the attach that follows", async () => {
		setState("connected", false);
		await attach("sess-a");
		await elapse(60_000);
		expect(calls).toBe(0);
		setState("connected", true);
		await attach("sess-a");
		expect(calls).toBe(1);
	});

	test("never asks while the page is hidden, and asks at once when it becomes visible", async () => {
		visibility = "hidden";
		await attach("sess-a");
		release = poll.acquireJobPollFocus();
		await elapse(60_000);
		expect(calls).toBe(0);

		await setVisibility("visible");
		expect(calls).toBe(1);
		await elapse(poll.JOB_POLL_FOCUSED_MS);
		expect(calls).toBe(2);

		await setVisibility("hidden");
		await elapse(60_000);
		expect(calls).toBe(2);
	});
});

describe("how often", () => {
	test("every 10 s with no focus holder", async () => {
		await attach("sess-a");
		await elapse(poll.JOB_POLL_IDLE_MS - 1);
		expect(calls).toBe(1);
		await elapse(1);
		expect(calls).toBe(2);
		await elapse(poll.JOB_POLL_IDLE_MS);
		expect(calls).toBe(3);
	});

	test("every 2 s while a surface holds focus, and back to 10 s once the last holder lets go", async () => {
		await attach("sess-a");
		const first = poll.acquireJobPollFocus();
		const second = poll.acquireJobPollFocus();
		await elapse(poll.JOB_POLL_FOCUSED_MS - 1);
		expect(calls).toBe(1);
		await elapse(1);
		expect(calls).toBe(2);
		await elapse(poll.JOB_POLL_FOCUSED_MS);
		expect(calls).toBe(3);

		first();
		first();
		await elapse(poll.JOB_POLL_FOCUSED_MS);
		expect(calls).toBe(4);

		second();
		await elapse(poll.JOB_POLL_IDLE_MS - 1);
		expect(calls).toBe(4);
		await elapse(1);
		expect(calls).toBe(5);
	});

	test("acquiring focus long after the last answer asks at once", async () => {
		await attach("sess-a");
		await elapse(poll.JOB_POLL_IDLE_MS - 1);
		release = poll.acquireJobPollFocus();
		await settle();
		// The idle period was nearly out; the faster one was out long ago.
		expect(calls).toBe(2);
		await elapse(poll.JOB_POLL_FOCUSED_MS - 1);
		expect(calls).toBe(2);
		await elapse(1);
		expect(calls).toBe(3);
	});
});

describe("job_widgets running count", () => {
	test("a change asks at once; the same count again does not", async () => {
		await attach("sess-a");
		expect(calls).toBe(1);
		applyJobWidgets({ running: 1, entries: [] });
		await settle();
		expect(calls).toBe(2);
		applyJobWidgets({ running: 1, entries: [] });
		await settle();
		expect(calls).toBe(2);
		applyJobWidgets({ running: 0, entries: [] });
		await settle();
		expect(calls).toBe(3);
	});

	test("a change while the page is hidden waits for the page", async () => {
		await attach("sess-a");
		visibility = "hidden";
		applyJobWidgets({ running: 2, entries: [] });
		await settle();
		expect(calls).toBe(1);
	});
});

describe("answers and workspaces", () => {
	test("an answer for a workspace the tab has left never shows", async () => {
		const pending = Promise.withResolvers<JobTreeDto>();
		handler = () => {
			calls++;
			return pending.promise;
		};
		await attach("sess-a");
		setState("currentWorkspaceId", "sess-b");
		answerWith(null);
		pending.resolve(treeOf(job("old")));
		await settle();
		expect(poll.jobPollView()).toEqual({ phase: "loading" });
		expect(poll.jobTreeRows()).toEqual([]);
	});

	test("the workspace switched to is asked on its own, not served the old one's call", async () => {
		const pending = Promise.withResolvers<JobTreeDto>();
		handler = () => {
			calls++;
			return pending.promise;
		};
		await attach("sess-a");
		expect(calls).toBe(1);
		answerWith(treeOf(job("new")));
		await attach("sess-b");
		expect(calls).toBe(2);
		expect(poll.jobTreeRows().map((row) => (row.kind === "job" ? row.job.id : ""))).toEqual([
			"new",
		]);
		pending.resolve(treeOf(job("old")));
		await settle();
		expect(poll.jobTreeRows().map((row) => (row.kind === "job" ? row.job.id : ""))).toEqual([
			"new",
		]);
	});

	test("detaching empties the snapshot, and the next attach starts from loading", async () => {
		await attach("sess-a");
		expect(poll.jobPollView().phase).toBe("ready");
		setState("currentWorkspaceId", "");
		expect(poll.jobPollView()).toEqual({ phase: "idle" });
		const pending = Promise.withResolvers<JobTreeDto>();
		handler = () => pending.promise;
		await attach("sess-a");
		expect(poll.jobPollView()).toEqual({ phase: "loading" });
		pending.resolve(tree);
		await settle();
		expect(poll.jobPollView().phase).toBe("ready");
	});

	test("overlapping refreshes share one request", async () => {
		await attach("sess-a");
		calls = 0;
		await Promise.all([poll.refreshJobTree(), poll.refreshJobTree(), poll.refreshJobTree()]);
		expect(calls).toBe(1);
	});

	test("a refresh with no workspace attached asks nothing", async () => {
		await poll.refreshJobTree();
		expect(calls).toBe(0);
	});

	test("a failed poll keeps the last tree and reports why; the next good one clears it", async () => {
		await attach("sess-a");
		handler = async () => {
			throw new Error("socket closed");
		};
		await poll.refreshJobTree();
		expect(poll.jobPollError()).toBe("socket closed");
		expect(poll.jobPollView().phase).toBe("ready");
		answerWith(tree);
		await poll.refreshJobTree();
		expect(poll.jobPollError()).toBeNull();
	});

	test("a failing call is retried on the period, not in a loop", async () => {
		handler = async () => {
			calls++;
			throw new Error("socket closed");
		};
		await attach("sess-a");
		expect(calls).toBe(1);
		await elapse(poll.JOB_POLL_IDLE_MS - 1);
		expect(calls).toBe(1);
		await elapse(1);
		expect(calls).toBe(2);
	});
});
