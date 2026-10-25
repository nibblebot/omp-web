import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ServerFrame, WireJobWidgetEntry } from "#lib/wire/protocol";
import { connect, setState, state } from "../../state";
import { jobWidgetView } from "../../store/job-widgets";
import { rejectPendingAttach, rejectPendingCalls } from "../../store/transport";
import {
	FakeWebSocket,
	attached,
	dispatch,
	installTransportStubs,
	restoreBrowserGlobals,
} from "../web.testkit";

const entry = (id: string, last: string, type = "bash"): WireJobWidgetEntry => ({
	id,
	type,
	view: {
		title: `${id} bench`,
		headline: { text: last },
		blocks: [
			{ kind: "spark", label: "tok/s", values: [1, 2, 3], min: 1, max: 3, last },
			{ kind: "meter", label: "trials", value: 0.5, text: "1/2 trials" },
		],
		state: "live",
		updatedAt: 1,
	},
});

/** A `job_widgets` frame as the fleet edge stamps it. */
const frame = (workspaceId: string, ...entries: WireJobWidgetEntry[]): ServerFrame => ({
	type: "job_widgets",
	running: entries.length,
	entries,
	workspaceId,
});

beforeEach(() => {
	installTransportStubs();
	setState({ currentWorkspaceId: "", jobWidgets: { running: 0, entries: [] }, connected: false });
	connect();
	FakeWebSocket.instances.at(-1)?.onopen?.();
});

afterEach(() => {
	rejectPendingCalls(new Error("test teardown"));
	rejectPendingAttach(new Error("test teardown"));
	setState("jobWidgets", { running: 0, entries: [] });
	restoreBrowserGlobals();
});

describe("job_widgets frames", () => {
	test("a snapshot becomes the attached session's running widgets, readable by job id", () => {
		dispatch(attached("a"));
		dispatch(frame("a", entry("bg_1", "186 tok/s"), entry("Owl", "41 ms", "task")));
		expect(state.jobWidgets.entries.map((e) => e.id)).toEqual(["bg_1", "Owl"]);
		expect(jobWidgetView("Owl")?.headline?.text).toBe("41 ms");
		expect(jobWidgetView("nobody")).toBeUndefined();
	});

	test("a job without a widget still counts as running", () => {
		dispatch(attached("a"));
		dispatch({ type: "job_widgets", running: 2, entries: [], workspaceId: "a" });
		expect(state.jobWidgets.running).toBe(2);
		expect(state.jobWidgets.entries).toEqual([]);
	});

	test("each frame replaces the set: a settled job leaves, a moved widget updates, an empty frame clears", () => {
		dispatch(attached("a"));
		dispatch(frame("a", entry("bg_1", "186 tok/s"), entry("bg_2", "41 ms")));
		dispatch(frame("a", entry("bg_2", "44 ms")));
		expect(state.jobWidgets.entries.map((e) => e.id)).toEqual(["bg_2"]);
		expect(jobWidgetView("bg_2")?.headline?.text).toBe("44 ms");
		expect(jobWidgetView("bg_1")).toBeUndefined();
		dispatch(frame("a"));
		expect(state.jobWidgets).toEqual({ running: 0, entries: [] });
	});

	test("a frame stamped for a session this tab no longer views is dropped", () => {
		dispatch(attached("a"));
		dispatch(attached("b"));
		dispatch(frame("a", entry("bg_1", "186 tok/s")));
		expect(state.jobWidgets).toEqual({ running: 0, entries: [] });
		dispatch(frame("b", entry("bg_9", "9 ms")));
		expect(state.jobWidgets.entries.map((e) => e.id)).toEqual(["bg_9"]);
	});

	test("switching sessions drops the widgets of the one left, and a re-attach starts from the priming", () => {
		dispatch(attached("a"));
		dispatch(frame("a", entry("bg_1", "186 tok/s")));
		dispatch(attached("b"));
		expect(state.jobWidgets).toEqual({ running: 0, entries: [] });
		dispatch(frame("b", entry("bg_2", "41 ms")));
		// A reconnect attaches the same session again: whatever ran is re-primed, never kept from before.
		dispatch(attached("b"));
		expect(state.jobWidgets).toEqual({ running: 0, entries: [] });
		dispatch(frame("b", entry("bg_3", "3 ms")));
		expect(state.jobWidgets.entries.map((e) => e.id)).toEqual(["bg_3"]);
	});
});
