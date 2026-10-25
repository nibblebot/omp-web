/**
 * The Activities panel's store rules (spec 961q): multi-expand across sections, `lastFocused`,
 * the accordion/detail carry rules, one-shot focus requests, route items, and the fallback for
 * subagents and jobs the attached session no longer has.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { JobDto, JobTreeDto } from "#lib/wire/protocol";
import type { SubagentInfo } from "../../state";
import { installLocalStorageShim, restoreBrowserGlobals } from "../web.testkit";

// The shared job poll is replaced by a settable answer; the store modules are imported after the mock so they bind to it.
import type { JobPollView } from "../../store/job-poll";
const realJobPoll = await import("../../store/job-poll");
const originalJobPoll = { ...realJobPoll };
let pollView: JobPollView = { phase: "idle" };
mock.module("../../store/job-poll", () => ({
	...originalJobPoll,
	jobPollView: () => pollView,
	jobTreeRows: () => (pollView.phase === "ready" ? pollView.tree.rows : []),
}));
afterAll(() => {
	mock.module("../../store/job-poll", () => originalJobPoll);
});

const { setState, state } = await import("../../state");
const { restoreDockLayout } = await import("../../store/dock");
const {
	applyActivitiesRoute,
	closeActivities,
	closeItemDetail,
	consumeFocusRequest,
	focusSection,
	isActivitiesOpen,
	openActivities,
	openItemDetail,
	reconcileMissingActivities,
	setActivitiesMode,
	toggleItemExpanded,
	toggleSectionCollapsed,
} = await import("../../store/activities");
const { readDockLayout } = await import("../../prefs/dock-layout");

const sub = (id: string) => ({ section: "subagents" as const, id });
const job = (id: string) => ({ section: "jobs" as const, id });
const daemon = (id: string) => ({ section: "daemons" as const, id });

function seedSubagents(...ids: string[]): void {
	setState(
		"subagents",
		new Map(
			ids.map((id) => [
				id,
				{ id, index: 0, agent: "task", status: "running", lastUpdate: 0 } as SubagentInfo,
			]),
		),
	);
}

function pollReady(...ids: string[]): void {
	const rows = ids.map((id) => ({
		depth: 0,
		rails: [],
		last: true,
		parent: false,
		kind: "job" as const,
		job: {
			id,
			type: "bash",
			status: "running",
			label: id,
			startTime: 1,
			own: true,
		} satisfies JobDto,
	}));
	const tree: JobTreeDto = { rootId: "Main", rows };
	pollView = { phase: "ready", tree, at: 1 };
}

let saved: Pick<typeof state, "currentWorkspaceId" | "subagents" | "subagentsLoaded">;

beforeEach(() => {
	installLocalStorageShim();
	saved = {
		currentWorkspaceId: state.currentWorkspaceId,
		subagents: state.subagents,
		subagentsLoaded: state.subagentsLoaded,
	};
	restoreDockLayout("__no-such-workspace__");
	setState({ currentWorkspaceId: "d1", subagentsLoaded: { mirror: false, roster: false } });
	pollView = { phase: "idle" };
});

afterEach(() => {
	restoreDockLayout("__no-such-workspace__");
	setState(saved);
	restoreBrowserGlobals();
});

describe("opening", () => {
	test("openActivities opens the dock; closeActivities closes only that dock", () => {
		expect(isActivitiesOpen()).toBe(false);
		openActivities();
		expect(isActivitiesOpen()).toBe(true);
		expect(state.dock).toEqual({ kind: "activities" });
		setState("dock", { kind: "tree" });
		closeActivities();
		expect(state.dock).toEqual({ kind: "tree" });
		openActivities();
		closeActivities();
		expect(state.dock).toBeNull();
	});

	test("a section request un-collapses it and asks the panel to scroll to it", () => {
		toggleSectionCollapsed("jobs");
		expect(state.activities.collapsedSections.has("jobs")).toBe(true);
		openActivities({ section: "jobs" });
		expect(state.activities.collapsedSections.has("jobs")).toBe(false);
		expect(state.activities.focusRequest).toEqual({ target: "jobs", seq: 1 });
		focusSection("daemons");
		expect(state.activities.focusRequest).toEqual({ target: "daemons", seq: 2 });
	});

	test("a section request leaves a detail so the section is on screen", () => {
		setActivitiesMode("detail");
		openActivities({ item: sub("a1") });
		expect(state.activities.detail).toEqual(sub("a1"));
		openActivities({ section: "jobs" });
		expect(state.activities.detail).toBeUndefined();
		expect(state.dock?.item).toBeUndefined();
	});

	test("a focus request is consumed only by the seq that was handled", () => {
		openActivities({ section: "jobs" });
		consumeFocusRequest(99);
		expect(state.activities.focusRequest?.seq).toBe(1);
		consumeFocusRequest(1);
		expect(state.activities.focusRequest).toBeUndefined();
	});

	test("an item request in the accordion expands it, un-collapses its section and scrolls to it", () => {
		toggleSectionCollapsed("subagents");
		openActivities({ item: sub("a1") });
		expect(state.activities.expanded.subagents.has("a1")).toBe(true);
		expect(state.activities.collapsedSections.has("subagents")).toBe(false);
		expect(state.activities.lastFocused).toEqual(sub("a1"));
		expect(state.activities.detail).toBeUndefined();
		expect(state.activities.focusRequest).toEqual({ target: sub("a1"), seq: 1 });
	});

	test("an item request in detail mode fills the panel with a subagent or job", () => {
		setActivitiesMode("detail");
		openActivities({ item: job("j1") });
		expect(state.activities.detail).toEqual(job("j1"));
		expect(state.activities.lastFocused).toEqual(job("j1"));
		expect(state.activities.expanded.jobs.has("j1")).toBe(false);
	});

	test("a daemon item expands in both modes and leaves any detail", () => {
		openActivities({ item: daemon("d9") });
		expect(state.activities.expanded.daemons.has("d9")).toBe(true);
		setActivitiesMode("detail");
		openActivities({ item: sub("a1") });
		openActivities({ item: daemon("d8") });
		expect(state.activities.expanded.daemons.has("d8")).toBe(true);
		expect(state.activities.detail).toBeUndefined();
		expect(state.activities.lastFocused).toEqual(sub("a1"));
	});
});

describe("multi-expand and lastFocused", () => {
	test("any number of rows stay expanded across sections", () => {
		toggleItemExpanded(sub("a1"));
		toggleItemExpanded(sub("a2"));
		toggleItemExpanded(job("j1"));
		toggleItemExpanded(daemon("d1"));
		expect([...state.activities.expanded.subagents]).toEqual(["a1", "a2"]);
		expect([...state.activities.expanded.jobs]).toEqual(["j1"]);
		expect([...state.activities.expanded.daemons]).toEqual(["d1"]);
	});

	test("lastFocused is the row last expanded and clears when that row collapses", () => {
		toggleItemExpanded(sub("a1"));
		toggleItemExpanded(job("j1"));
		expect(state.activities.lastFocused).toEqual(job("j1"));
		toggleItemExpanded(sub("a1")); // collapsing another row leaves it alone
		expect(state.activities.lastFocused).toEqual(job("j1"));
		toggleItemExpanded(job("j1"));
		expect(state.activities.lastFocused).toBeUndefined();
	});

	test("a daemon row never becomes lastFocused", () => {
		toggleItemExpanded(sub("a1"));
		toggleItemExpanded(daemon("d1"));
		expect(state.activities.lastFocused).toEqual(sub("a1"));
		toggleItemExpanded(daemon("d1"));
		expect(state.activities.lastFocused).toEqual(sub("a1"));
	});

	test("opening an item in detail makes it lastFocused; Back to the list keeps it", () => {
		setActivitiesMode("detail");
		openActivities();
		openItemDetail(sub("a1"));
		expect(state.activities.lastFocused).toEqual(sub("a1"));
		closeItemDetail();
		expect(state.activities.detail).toBeUndefined();
		expect(state.activities.lastFocused).toEqual(sub("a1"));
	});
});

describe("mode switch carry rules", () => {
	test("accordion to detail opens lastFocused, other expansions unchanged", () => {
		toggleItemExpanded(sub("a1"));
		toggleItemExpanded(job("j1"));
		setActivitiesMode("detail");
		expect(state.activities.mode).toBe("detail");
		expect(state.activities.detail).toEqual(job("j1"));
		expect([...state.activities.expanded.subagents]).toEqual(["a1"]);
		expect([...state.activities.expanded.jobs]).toEqual(["j1"]);
	});

	test("accordion to detail with nothing focused shows the list", () => {
		toggleItemExpanded(sub("a1"));
		toggleItemExpanded(sub("a1"));
		setActivitiesMode("detail");
		expect(state.activities.detail).toBeUndefined();
	});

	test("detail to accordion expands the detail item and scrolls to it", () => {
		setActivitiesMode("detail");
		openActivities({ item: sub("a1") });
		toggleItemExpanded(daemon("d1"));
		setActivitiesMode("accordion");
		expect(state.activities.detail).toBeUndefined();
		expect(state.activities.expanded.subagents.has("a1")).toBe(true);
		expect(state.activities.expanded.daemons.has("d1")).toBe(true);
		expect(state.activities.focusRequest).toMatchObject({ target: sub("a1") });
	});

	test("detail to accordion after Back still expands the last focused item", () => {
		setActivitiesMode("detail");
		openItemDetail(job("j1"));
		closeItemDetail();
		setActivitiesMode("accordion");
		expect(state.activities.expanded.jobs.has("j1")).toBe(true);
	});

	test("switching to the mode it already has changes nothing", () => {
		openActivities({ section: "jobs" });
		const request = state.activities.focusRequest;
		setActivitiesMode("accordion");
		expect(state.activities.focusRequest).toEqual(request);
	});
});

describe("the detail item in the URL state", () => {
	test("state.dock.item mirrors the open detail and clears with it", () => {
		setActivitiesMode("detail");
		openActivities();
		openItemDetail(sub("a 1"));
		expect(state.dock).toEqual({ kind: "activities", item: { type: "subagent", id: "a 1" } });
		openItemDetail(job("j1"));
		expect(state.dock?.item).toEqual({ type: "job", id: "j1" });
		closeItemDetail();
		expect(state.dock?.item).toBeUndefined();
	});

	test("an item route opens in the saved mode: expanded in the accordion, filling the panel in detail", () => {
		applyActivitiesRoute({ kind: "activities", item: { type: "subagent", id: "a1" } });
		expect(state.dock?.kind).toBe("activities");
		expect(state.activities.mode).toBe("accordion");
		expect(state.activities.expanded.subagents.has("a1")).toBe(true);
		expect(state.activities.detail).toBeUndefined();

		setActivitiesMode("detail");
		applyActivitiesRoute({ kind: "activities", item: { type: "job", id: "j1" } });
		expect(state.activities.mode).toBe("detail");
		expect(state.activities.detail).toEqual(job("j1"));
		expect(state.dock?.item).toEqual({ type: "job", id: "j1" });
	});

	test("opening the route never changes the saved mode", () => {
		setActivitiesMode("detail");
		applyActivitiesRoute({ kind: "activities" });
		expect(state.activities.mode).toBe("detail");
		expect(readDockLayout("d1").activities.mode).toBe("detail");
	});

	test("a bare activities route returns a detail to the list (Back from an item URL)", () => {
		setActivitiesMode("detail");
		applyActivitiesRoute({ kind: "activities", item: { type: "subagent", id: "a1" } });
		applyActivitiesRoute({ kind: "activities" });
		expect(state.activities.detail).toBeUndefined();
		expect(state.dock).toEqual({ kind: "activities" });
	});

	test("an item type the panel does not know opens the list", () => {
		applyActivitiesRoute({ kind: "activities", item: { type: "widget", id: "w1" } });
		expect(state.dock).toEqual({ kind: "activities" });
		expect(state.activities.expanded.subagents.size).toBe(0);
		expect(state.activities.detail).toBeUndefined();
	});
});

describe("missing subagent and job fallback", () => {
	test("is not decided while the forest is still loading", () => {
		setActivitiesMode("detail");
		openActivities({ item: sub("gone") });
		reconcileMissingActivities();
		expect(state.activities.detail).toEqual(sub("gone"));
		setState("subagentsLoaded", { mirror: true, roster: false });
		reconcileMissingActivities();
		expect(state.activities.detail).toEqual(sub("gone"));
	});

	test("a missing detail falls back to the list and forgets lastFocused", () => {
		setActivitiesMode("detail");
		openActivities({ item: sub("gone") });
		setState("subagentsLoaded", { mirror: true, roster: true });
		reconcileMissingActivities();
		expect(state.activities.detail).toBeUndefined();
		expect(state.activities.lastFocused).toBeUndefined();
		expect(state.dock).toEqual({ kind: "activities" });
		expect(readDockLayout("d1").activities.lastFocused).toBeUndefined();
	});

	test("missing expanded subagents collapse; present ones and a closed dock are untouched", () => {
		seedSubagents("a1");
		toggleItemExpanded(sub("a1"));
		toggleItemExpanded(sub("gone"));
		setState("subagentsLoaded", { mirror: true, roster: true });
		reconcileMissingActivities();
		expect([...state.activities.expanded.subagents]).toEqual(["a1"]);
		expect(state.dock).toBeNull();
	});

	test("jobs are judged only once the shared poll has answered", () => {
		toggleItemExpanded(job("j-gone"));
		toggleItemExpanded(job("j1"));
		setState("subagentsLoaded", { mirror: true, roster: true });
		reconcileMissingActivities();
		expect([...state.activities.expanded.jobs]).toEqual(["j-gone", "j1"]);
		pollView = { phase: "loading" };
		reconcileMissingActivities();
		expect([...state.activities.expanded.jobs]).toEqual(["j-gone", "j1"]);
		pollReady("j1");
		reconcileMissingActivities();
		expect([...state.activities.expanded.jobs]).toEqual(["j1"]);
		expect(state.activities.lastFocused).toEqual(job("j1"));
	});

	test("a task job is not a Jobs item", () => {
		toggleItemExpanded(job("t1"));
		const tree: JobTreeDto = {
			rows: [
				{
					depth: 0,
					rails: [],
					last: true,
					parent: false,
					kind: "job",
					job: { id: "t1", type: "task", status: "running", label: "t", startTime: 1, own: true },
				},
			],
		};
		pollView = { phase: "ready", tree, at: 1 };
		reconcileMissingActivities();
		expect(state.activities.expanded.jobs.size).toBe(0);
	});

	test("nothing is decided while no workspace is attached", () => {
		toggleItemExpanded(sub("gone"));
		setState({ currentWorkspaceId: "", subagentsLoaded: { mirror: true, roster: true } });
		reconcileMissingActivities();
		expect(state.activities.expanded.subagents.has("gone")).toBe(true);
	});
});
