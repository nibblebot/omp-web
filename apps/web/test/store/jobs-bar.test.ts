/**
 * The composer jobs bar's presence: running jobs show it, the last one ending leaves a "finished" note for
 * the SDK's recent window, then it hides. A session switch or an attach starts over.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { setState, state } from "../../state";
import { applyJobWidgets, clearJobWidgets } from "../../store/job-widgets";
import { JOBS_FINISHED_LINGER_MS, jobsBarView } from "../../store/jobs-bar";

const originalSession = state.currentSessionId;

const frame = (running: number) => applyJobWidgets({ running, entries: [] });

beforeEach(() => {
	vi.useFakeTimers();
	setState("currentSessionId", "sess-a");
	clearJobWidgets();
});
afterEach(() => {
	clearJobWidgets();
	vi.useRealTimers();
});
afterAll(() => {
	setState("currentSessionId", originalSession);
});

describe("jobs bar presence", () => {
	test("is hidden before any job ran", () => {
		expect(jobsBarView()).toBeUndefined();
		frame(0);
		expect(jobsBarView()).toBeUndefined();
	});

	test("shows the running count, then lingers as finished, then hides", () => {
		frame(2);
		expect(jobsBarView()).toEqual({ phase: "running", running: 2 });
		frame(1);
		expect(jobsBarView()).toEqual({ phase: "running", running: 1 });
		frame(0);
		expect(jobsBarView()).toEqual({ phase: "finished" });
		vi.advanceTimersByTime(JOBS_FINISHED_LINGER_MS - 1);
		expect(jobsBarView()).toEqual({ phase: "finished" });
		vi.advanceTimersByTime(1);
		expect(jobsBarView()).toBeUndefined();
	});

	test("a new job during the linger replaces the note, and its end starts a fresh window", () => {
		frame(1);
		frame(0);
		expect(jobsBarView()).toEqual({ phase: "finished" });
		vi.advanceTimersByTime(JOBS_FINISHED_LINGER_MS / 2);
		frame(1);
		expect(jobsBarView()).toEqual({ phase: "running", running: 1 });
		// The superseded note's timer must not hide the later one early.
		frame(0);
		expect(jobsBarView()).toEqual({ phase: "finished" });
		vi.advanceTimersByTime(JOBS_FINISHED_LINGER_MS - 1);
		expect(jobsBarView()).toEqual({ phase: "finished" });
		vi.advanceTimersByTime(1);
		expect(jobsBarView()).toBeUndefined();
	});

	test("an attach (clearJobWidgets) drops a lingering note", () => {
		frame(1);
		frame(0);
		expect(jobsBarView()).toBeDefined();
		clearJobWidgets();
		expect(jobsBarView()).toBeUndefined();
		vi.advanceTimersByTime(JOBS_FINISHED_LINGER_MS);
		expect(jobsBarView()).toBeUndefined();
	});

	test("another session's note never shows, and its frames start a fresh episode", () => {
		frame(3);
		frame(0);
		expect(jobsBarView()).toEqual({ phase: "finished" });
		setState("currentSessionId", "sess-b");
		expect(jobsBarView()).toBeUndefined();
		frame(1);
		expect(jobsBarView()).toEqual({ phase: "running", running: 1 });
		frame(0);
		expect(jobsBarView()).toEqual({ phase: "finished" });
	});
});
