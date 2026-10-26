/**
 * A reloaded transcript's cards parked on a running job learn their outcome from the session's
 * job list (`reconcileBackgroundCards`): a settled job settles its card, a running one keeps it,
 * and a job the list cannot vouch for leaves a plain done card.
 */
import { afterAll, beforeEach, describe, expect, mock, test, vi } from "bun:test";
import type { JobDto, JobTreeDto, WireSessionEvent } from "#lib/wire/protocol";
import type { ToolItem } from "../../state";
import * as transport from "../../store/transport";

// The transport is mocked per test; the store modules are imported after the mock so they bind to it.
let handler: (method: string, args: unknown[]) => Promise<unknown> = async () => undefined;
const originalTransport = { ...transport };
mock.module("../../store/transport", () => ({
	...originalTransport,
	call: (method: string, args: unknown[]) => handler(method, args),
}));

afterAll(async () => {
	// mock.restore() leaves module mocks installed; reinstall the real exports for later files.
	mock.module("../../store/transport", () => originalTransport);
	setState("items", []);
	// Detach so the poll drops the re-armed timer the file's refreshes left behind, then hand the id back.
	setState("currentWorkspaceId", "");
	clearJobWidgets();
	await Promise.resolve();
	setState("currentWorkspaceId", originalSession);
});

// Dynamic imports: the transport mock must be registered before the store modules bind to it.
const { setState, state } = await import("../../state");
const { applyEvent } = await import("../../store/chat");
const { clearJobWidgets } = await import("../../store/job-widgets");
const { reconcileBackgroundCards } = await import("../../store/background-cards");
const originalSession = state.currentWorkspaceId;

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
const held = <T>() => Promise.withResolvers<T>();

let calls: string[] = [];
const answer = (tree: JobTreeDto | null | Error) => {
	handler = async (method) => {
		calls.push(method);
		if (tree instanceof Error) throw tree;
		return tree;
	};
};

const CALL = "call_bg";
const START_TEXT = "Backgrounded as job bg_1";
/** A bash call that returned while its job runs, as a reloaded transcript shows it. */
function parkedCard(): ToolItem {
	return {
		kind: "tool",
		id: 1,
		toolCallId: CALL,
		name: "bash",
		args: { command: "sleep 9" },
		status: "done",
		output: START_TEXT,
		background: { jobId: "bg_1", type: "bash", state: "running", jobIds: ["bg_1"], startedAt: 1 },
	};
}
function card(): ToolItem {
	const item = state.items.find((it) => it.kind === "tool");
	if (item?.kind !== "tool") throw new Error("no tool card");
	return item;
}

beforeEach(async () => {
	calls = [];
	// Detach, then attach: the previous test's job tree is gone (the connection is down, so the poll's own timer stays quiet).
	setState("currentWorkspaceId", "");
	clearJobWidgets();
	await Promise.resolve();
	setState("currentWorkspaceId", "sess-a");
	setState("items", [parkedCard()]);
});

describe("reconciling parked cards against the job list", () => {
	test("a job that settled settles its card with how long it ran", async () => {
		answer(treeOf(job("bg_1", { status: "completed", startTime: 1000, endTime: 4500 })));
		await reconcileBackgroundCards();
		expect(card()).toMatchObject({
			status: "done",
			background: { state: "completed", durationMs: 3500 },
		});
	});

	test("reads a fresh list on each reload, not the earlier answer", async () => {
		answer(treeOf(job("bg_1")));
		await reconcileBackgroundCards();
		expect(card().background).toMatchObject({ state: "running" });
		answer(treeOf(job("bg_1", { status: "failed", startTime: 1000, endTime: 2000 })));
		await reconcileBackgroundCards();
		expect(card().background).toMatchObject({ state: "failed" });
	});

	test("a job still running keeps its card parked", async () => {
		answer(treeOf(job("bg_1")));
		await reconcileBackgroundCards();
		expect(card()).toMatchObject({ status: "done", background: { state: "running" } });
	});

	test.each([
		["has no row for the job", treeOf(job("other", { status: "completed", endTime: 2000 }))],
		["has no job manager", null],
		["cannot be read", new Error("Not connected")],
	])("a job list that %s leaves a plain done card", async (_name, answered) => {
		answer(answered);
		await reconcileBackgroundCards();
		expect(card()).toMatchObject({ status: "done", output: START_TEXT });
		expect(card().background).toBeUndefined();
	});

	test("an answer for a session the page has left changes nothing", async () => {
		const pending = held<JobTreeDto>();
		handler = () => pending.promise;
		const reconciling = reconcileBackgroundCards();
		setState("currentWorkspaceId", "sess-b");
		pending.resolve(treeOf(job("bg_1", { status: "completed", endTime: 2000 })));
		await reconciling;
		expect(card().background).toMatchObject({ state: "running" });
	});

	test("a transcript with no parked card never asks for the list", async () => {
		setState("items", [{ ...parkedCard(), background: undefined }]);
		answer(treeOf(job("bg_1")));
		await reconcileBackgroundCards();
		expect(calls).toEqual([]);
	});

	test("output buffered while the list was loading survives the card settling", async () => {
		vi.useFakeTimers();
		let nextFrame = 0;
		// A real rAF flushes a frame later; the card settles before then. Bun's test env has none.
		globalThis.requestAnimationFrame = (flush) => {
			setTimeout(() => flush(performance.now()), 16);
			return ++nextFrame;
		};
		try {
			const pending = held<JobTreeDto>();
			handler = () => pending.promise;
			const reconciling = reconcileBackgroundCards();
			const frame: WireSessionEvent = {
				type: "tool_execution_update",
				toolCallId: CALL,
				toolName: "bash",
				output: "job output line\n",
			};
			applyEvent(frame);
			pending.resolve(treeOf(job("bg_1", { status: "completed", startTime: 1000, endTime: 2000 })));
			await reconciling;
			vi.advanceTimersByTime(20);
			expect(card()).toMatchObject({
				status: "done",
				output: "job output line\n",
				background: { state: "completed" },
			});
		} finally {
			vi.useRealTimers();
			Reflect.deleteProperty(globalThis, "requestAnimationFrame");
		}
	});
});
