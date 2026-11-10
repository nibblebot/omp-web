import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { connect, setState, state } from "../../state";
import {
	backFromDock,
	closeDock,
	isActivitiesShortcut,
	openDock,
	pruneDockLayoutsToRoster,
	restoreDockLayout,
	setDockWidth,
} from "../../store/dock";
import {
	openActivities,
	openItemDetail,
	setActivityFilter,
	setActivitiesMode,
	toggleItemExpanded,
	toggleSectionCollapsed,
	toggleSubagentTreeRow,
} from "../../store/activities";
import { type DockLayout, readDockLayout } from "../../prefs/dock-layout";
import {
	attached,
	dispatch,
	FakeWebSocket,
	installLocalStorageShim,
	installTransportStubs,
	restoreBrowserGlobals,
} from "../web.testkit";
import type { RosterEntry } from "#lib/wire/protocol";

function key(init: { key: string; altKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }) {
	return { altKey: false, ctrlKey: false, shiftKey: false, ...init };
}

const STORAGE_KEY = "omp-web:dock-layouts:v2";
const LEGACY_STORAGE_KEY = "omp-web:dock-layouts:v1";

let saved: Pick<typeof state, "currentWorkspaceId" | "sessionRoster">;

/** A workspace with no saved layout restores the defaults: the closed dock and a fresh Activities slice. */
function resetLive(): void {
	restoreDockLayout("__no-such-workspace__");
}

beforeEach(() => {
	installLocalStorageShim();
	saved = { currentWorkspaceId: state.currentWorkspaceId, sessionRoster: state.sessionRoster };
	resetLive();
	setState("currentWorkspaceId", "d1");
});

afterEach(() => {
	resetLive();
	setState({ currentWorkspaceId: saved.currentWorkspaceId, sessionRoster: saved.sessionRoster });
	restoreBrowserGlobals();
});

describe("isActivitiesShortcut (Alt+A)", () => {
	test("matches Alt+A from anywhere, including a focused composer textarea", () => {
		expect(isActivitiesShortcut(key({ key: "a", altKey: true }))).toBe(true);
		expect(isActivitiesShortcut(key({ key: "A", altKey: true }))).toBe(true);
	});

	test("rejects the bare key and chords with other modifiers", () => {
		expect(isActivitiesShortcut(key({ key: "a" }))).toBe(false);
		expect(isActivitiesShortcut(key({ key: "a", altKey: true, ctrlKey: true }))).toBe(false);
		expect(isActivitiesShortcut(key({ key: "a", altKey: true, shiftKey: true }))).toBe(false);
	});

	test("rejects Option+A on mac, which types a different character", () => {
		expect(isActivitiesShortcut(key({ key: "å", altKey: true }))).toBe(false);
	});
});

describe("open, close and Back on the dock", () => {
	test("openDock retargets the panel and closeDock closes it", () => {
		openDock("review");
		expect(state.dock).toEqual({ kind: "review" });
		openDock("tree");
		expect(state.dock).toEqual({ kind: "tree" });
		closeDock();
		expect(state.dock).toBeNull();
	});

	test("Back in the Activities detail steps back to the list; the dock stays open", () => {
		setActivitiesMode("detail");
		openActivities({ item: { section: "subagents", id: "a1" } });
		expect(state.activities.detail).toEqual({ section: "subagents", id: "a1" });
		backFromDock();
		expect(state.activities.detail).toBeUndefined();
		expect(state.dock?.kind).toBe("activities");
		backFromDock();
		expect(state.dock).toBeNull();
	});

	test("Back on any other panel closes it", () => {
		openDock("tree");
		backFromDock();
		expect(state.dock).toBeNull();
	});

	test("the dock width is clamped and global", () => {
		setDockWidth(10_000);
		expect(state.dockWidth).toBeLessThan(10_000);
	});
});

describe("per-workspace dock layout (v2)", () => {
	function attachWorkspace(id: string): void {
		dispatch(attached(id));
	}

	beforeEach(() => {
		installTransportStubs();
		setState({ currentWorkspaceId: "" });
		connect();
		FakeWebSocket.instances.at(-1)?.onopen?.();
	});

	test("every change is saved to the attached workspace's record", () => {
		attachWorkspace("d1");
		openDock("review");
		expect(readDockLayout("d1").dock).toEqual({ kind: "review" });
		openActivities();
		setActivitiesMode("detail");
		setActivitiesMode("accordion");
		toggleItemExpanded({ section: "subagents", id: "a1" });
		toggleItemExpanded({ section: "jobs", id: "j1" });
		toggleItemExpanded({ section: "daemons", id: "d9" });
		toggleSubagentTreeRow("a2");
		toggleSectionCollapsed("jobs");
		setActivityFilter("jobs", "running");
		expect(readDockLayout("d1")).toEqual({
			dock: { kind: "activities" },
			activities: {
				mode: "accordion",
				collapsedSections: ["jobs"],
				expanded: { subagents: ["a1"], jobs: ["j1"], daemons: ["d9"] },
				treeCollapsed: ["a2"],
				filters: { subagents: "all", jobs: "running" },
				lastFocused: { section: "jobs", id: "j1" },
			},
		});
		closeDock();
		expect(readDockLayout("d1").dock).toBeNull();
		expect(readDockLayout("d1").activities.expanded.subagents).toEqual(["a1"]);
	});

	test("a viewport where the dock covers the screen restores the layout but not the open panel", () => {
		attachWorkspace("d1");
		openActivities();
		toggleSectionCollapsed("jobs");
		const wasDrawer = state.drawerViewport;
		setState("drawerViewport", true);
		try {
			restoreDockLayout("d1");
			expect(state.dock).toBeNull();
			expect(state.activities.collapsedSections.has("jobs")).toBe(true);
			// The record keeps the panel for a wide viewport.
			expect(readDockLayout("d1").dock).toEqual({ kind: "activities" });
			setState("drawerViewport", false);
			restoreDockLayout("d1");
			expect(state.dock?.kind).toBe("activities");
		} finally {
			setState("drawerViewport", wasDrawer);
		}
	});

	test("the open detail is not saved; the URL carries it", () => {
		attachWorkspace("d1");
		openActivities();
		setActivitiesMode("detail");
		openItemDetail({ section: "subagents", id: "a1" });
		const layout = readDockLayout("d1");
		expect(layout.dock).toEqual({ kind: "activities" });
		expect(layout.activities.mode).toBe("detail");
		expect(layout.activities.lastFocused).toEqual({ section: "subagents", id: "a1" });
		expect(Object.keys(layout.activities)).not.toContain("detail");
	});

	test("switching workspace restores that workspace's own dock and layout", () => {
		attachWorkspace("d1");
		openActivities();
		setActivitiesMode("detail");
		toggleItemExpanded({ section: "subagents", id: "a1" });
		toggleSubagentTreeRow("a2");
		setActivityFilter("subagents", "running");

		attachWorkspace("d2");
		expect(state.dock).toBeNull();
		expect(state.activities.mode).toBe("accordion");
		expect(state.activities.expanded.subagents.size).toBe(0);
		expect(state.activities.treeCollapsed.size).toBe(0);
		expect(state.activities.filters.subagents).toBe("all");
		expect(state.activities.lastFocused).toBeUndefined();
		openDock("tree");

		attachWorkspace("d1");
		expect(state.dock).toEqual({ kind: "activities" });
		expect(state.activities.mode).toBe("detail");
		expect([...state.activities.expanded.subagents]).toEqual(["a1"]);
		expect([...state.activities.treeCollapsed]).toEqual(["a2"]);
		expect(state.activities.filters.subagents).toBe("running");
		expect(state.activities.lastFocused).toEqual({ section: "subagents", id: "a1" });

		attachWorkspace("d2");
		expect(state.dock).toEqual({ kind: "tree" });
		expect(state.activities.filters.subagents).toBe("all");
	});

	test("restoring does not write the previous workspace's dock over the new record", () => {
		attachWorkspace("d1");
		openDock("review");
		attachWorkspace("d2");
		expect(readDockLayout("d2").dock).toBeNull();
		expect(readDockLayout("d1").dock).toEqual({ kind: "review" });
	});

	test("a re-attach of the same workspace keeps the live dock", () => {
		attachWorkspace("d1");
		openDock("review");
		attachWorkspace("d1");
		expect(state.dock).toEqual({ kind: "review" });
	});

	test("nothing is saved while no workspace is attached", () => {
		setState("currentWorkspaceId", "");
		openDock("review");
		expect(globalThis.localStorage.getItem(STORAGE_KEY)).toBeNull();
	});

	test("the v1 record is deleted on load and never migrated", () => {
		globalThis.localStorage.setItem(
			LEGACY_STORAGE_KEY,
			JSON.stringify({
				d1: { dock: { kind: "agents" }, mode: "accordion", filter: "running", treeCollapsed: [] },
			}),
		);
		const layout = readDockLayout("d1");
		expect(globalThis.localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
		expect(layout.dock).toBeNull();
		expect(layout.activities.filters.subagents).toBe("all");
	});
});

describe("pruning on roster removal", () => {
	function roster(...ids: string[]): void {
		setState(
			"sessionRoster",
			ids.map((workspaceId) => ({ workspaceId, status: "ready" }) as unknown as RosterEntry),
		);
	}

	function saveFor(workspaceId: string, kind = "review"): void {
		setState("currentWorkspaceId", workspaceId);
		openDock(kind);
	}

	test("drops records of workspaces that left the roster", () => {
		saveFor("d1");
		saveFor("d2", "tree");
		roster("d2");
		pruneDockLayoutsToRoster();
		expect(Object.keys(JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY) ?? "{}"))).toEqual([
			"d2",
		]);
	});

	test("never prunes on an empty roster", () => {
		saveFor("d1");
		roster();
		pruneDockLayoutsToRoster();
		expect(readDockLayout("d1").dock).toEqual({ kind: "review" });
	});
});

describe("corrupt storage", () => {
	const defaults: DockLayout = {
		dock: null,
		activities: {
			mode: "accordion",
			collapsedSections: [],
			expanded: { subagents: [], jobs: [], daemons: [] },
			treeCollapsed: [],
			filters: { subagents: "all", jobs: "all" },
		},
	};

	test("unparseable storage reads as the default layout", () => {
		globalThis.localStorage.setItem(STORAGE_KEY, "{not json");
		expect(readDockLayout("d1")).toEqual(defaults);
	});

	test("unknown shapes fall back field by field", () => {
		globalThis.localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				d1: {
					dock: { kind: 7 },
					activities: { mode: "wide", expanded: 4, treeCollapsed: "a1", filters: 3 },
				},
				d2: {
					dock: { kind: "activities", id: "ignored" },
					activities: {
						mode: "detail",
						collapsedSections: ["jobs", "bogus", 3],
						expanded: { subagents: ["a1", "", 5, "a1"], jobs: "j1" },
						treeCollapsed: ["a2", 3, ""],
						filters: { subagents: "parked", jobs: "bogus" },
						lastFocused: { section: "subagents", id: "a1" },
					},
				},
				d3: "nope",
				d4: {
					activities: {
						lastFocused: { section: "daemons", id: "x" },
						filters: { subagents: "bogus", jobs: "done" },
					},
				},
			}),
		);
		expect(readDockLayout("d1")).toEqual(defaults);
		expect(readDockLayout("d2")).toEqual({
			dock: { kind: "activities" },
			activities: {
				mode: "detail",
				collapsedSections: ["jobs"],
				expanded: { subagents: ["a1"], jobs: [], daemons: [] },
				treeCollapsed: ["a2"],
				filters: { subagents: "parked", jobs: "all" },
				lastFocused: { section: "subagents", id: "a1" },
			},
		});
		expect(readDockLayout("d3")).toEqual(defaults);
		expect(readDockLayout("d4").activities.lastFocused).toBeUndefined();
		expect(readDockLayout("d4").activities.filters).toEqual({ subagents: "all", jobs: "all" });
	});

	test("storage that is not an object reads as no layouts", () => {
		globalThis.localStorage.setItem(STORAGE_KEY, "[1,2]");
		expect(readDockLayout("d1").dock).toBeNull();
	});
});
