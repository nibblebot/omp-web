/** Roster refreshes on lifecycle edges are single-flight and paced: a fan-out's edges share one trailing read. */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as transport from "../../store/transport";
import { requestRosterRefresh, resetRosterRefresh } from "../../store/subagents";

let reads = 0;
let release: (() => void) | undefined;
let hold = false;

const originalTransport = { ...transport };
// Installed from a hook: a top-level mock would be replaced by an earlier file's afterAll restore.
beforeAll(() => {
	mock.module("../../store/transport", () => ({
		...originalTransport,
		call: async (method: string) => {
			if (method !== "workerList") return undefined;
			reads += 1;
			if (hold) await new Promise<void>((resolve) => (release = resolve));
			return { workers: [] };
		},
	}));
});

afterAll(() => {
	// Settle a read the last test may have left held, and leave no timer behind this file's mock.
	hold = false;
	release?.();
	resetRosterRefresh();
	mock.module("../../store/transport", () => originalTransport);
	setState("currentWorkspaceId", previousWorkspaceId);
});

const { state, setState } = await import("../../state");
const previousWorkspaceId = state.currentWorkspaceId;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
	// The scheduler is module-level (timer, in-flight read, pacing, backoff), and earlier files'
	// lifecycle frames already advanced it: a retry or paced read they left pending would land here
	// and add a read this file never asked for.
	resetRosterRefresh();
	setState("currentWorkspaceId", "roster-refresh");
	reads = 0;
	hold = false;
});

describe("requestRosterRefresh", () => {
	test("requests in one burst read the roster once", async () => {
		for (let i = 0; i < 20; i++) requestRosterRefresh();
		await wait(60);
		expect(reads).toBe(1);
		// Let the pacing window of this test's read pass before the next test starts.
		await wait(520);
	});

	test("edges arriving while a read is in flight collapse into one trailing read", async () => {
		hold = true;
		requestRosterRefresh();
		await wait(60);
		expect(reads).toBe(1);
		for (let i = 0; i < 20; i++) requestRosterRefresh();
		await wait(60);
		expect(reads).toBe(1);

		hold = false;
		release?.();
		await wait(650);
		expect(reads).toBe(2);
	});
});
