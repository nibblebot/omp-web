import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SubagentInfo } from "../../state";
import { connect, setState, state } from "../../state";
import {
	agentsFilter,
	agentsMode,
	agentTreeCollapsed,
	applyRouteDock,
	backFromDock,
	closeDock,
	expandedAgentId,
	isAgentsShortcut,
	openAgent,
	openAgents,
	openDock,
	pruneDockLayoutsToRoster,
	reconcileMissingAgent,
	setAgentsFilter,
	setAgentsMode,
	toggleAgentExpanded,
	toggleAgentTreeCollapsed,
} from "../../store/dock";
import { readDockLayout } from "../../prefs/dock-layout";
import {
	attached,
	dispatch,
	FakeWebSocket,
	installLocalStorageShim,
	installTransportStubs,
	restoreBrowserGlobals,
} from "../web.testkit";
import type { DaemonEntry } from "#lib/wire/protocol";

function key(init: { key: string; altKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }) {
	return { altKey: false, ctrlKey: false, shiftKey: false, ...init };
}

const STORAGE_KEY = "omp-web:dock-layouts:v1";

const layoutDefaults = {
	dock: null,
	agentsMode: "single" as const,
	agentsFilter: "all" as const,
	agentsExpanded: undefined,
	agentTreeCollapsed: new Set<string>(),
	subagentsLoaded: { mirror: false, roster: false },
};

let saved: Pick<typeof state, "currentSessionId" | "subagents" | "daemonRoster">;

beforeEach(() => {
	installLocalStorageShim();
	saved = {
		currentSessionId: state.currentSessionId,
		subagents: state.subagents,
		daemonRoster: state.daemonRoster,
	};
	setState({ ...layoutDefaults, currentSessionId: "d1" });
});

afterEach(() => {
	setState({
		...layoutDefaults,
		currentSessionId: saved.currentSessionId,
		subagents: saved.subagents,
		daemonRoster: saved.daemonRoster,
	});
	restoreBrowserGlobals();
});

function agent(id: string): [string, SubagentInfo] {
	return [id, { id, index: 0, agent: "task", status: "running", lastUpdate: 0 } as SubagentInfo];
}

function seedAgents(...ids: string[]): void {
	setState("subagents", new Map(ids.map(agent)));
}

function loadForest(): void {
	setState("subagentsLoaded", { mirror: true, roster: true });
}

describe("isAgentsShortcut (Alt+A)", () => {
	test("matches Alt+A from anywhere, including a focused composer textarea", () => {
		expect(isAgentsShortcut(key({ key: "a", altKey: true }))).toBe(true);
		expect(isAgentsShortcut(key({ key: "A", altKey: true }))).toBe(true);
	});

	test("rejects the bare key and chords with other modifiers", () => {
		expect(isAgentsShortcut(key({ key: "a" }))).toBe(false);
		expect(isAgentsShortcut(key({ key: "a", altKey: true, ctrlKey: true }))).toBe(false);
		expect(isAgentsShortcut(key({ key: "a", altKey: true, shiftKey: true }))).toBe(false);
	});

	test("rejects Option+A on mac, which types a different character", () => {
		expect(isAgentsShortcut(key({ key: "å", altKey: true }))).toBe(false);
	});
});

describe("backFromDock (Back and Esc on the dock)", () => {
	test("an agent pane steps back to the agents list", () => {
		setState("dock", { kind: "agent", id: "a1" });
		backFromDock();
		expect(state.dock?.id).toBeUndefined();
		expect(state.dock?.kind).toBe("agents");
	});

	test("the agents list and other panels close", () => {
		setState("dock", { kind: "agents" });
		backFromDock();
		expect(state.dock).toBeNull();
		setState("dock", { kind: "tree" });
		backFromDock();
		expect(state.dock).toBeNull();
	});

	test("an expanded accordion row closes the dock and stays remembered", () => {
		setAgentsMode("accordion");
		openAgent("a1");
		backFromDock();
		expect(state.dock).toBeNull();
		expect(state.agentsExpanded).toBe("a1");
		openAgents();
		expect(expandedAgentId()).toBe("a1");
	});
});

describe("agents modes", () => {
	test("a fresh workspace starts closed in single mode", () => {
		expect(state.dock).toBeNull();
		expect(agentsMode()).toBe("single");
		expect(expandedAgentId()).toBeUndefined();
		expect(agentTreeCollapsed().size).toBe(0);
	});

	test("openAgent opens the pane in single mode and expands the row in accordion mode", () => {
		openAgent("a1");
		expect(state.dock).toEqual({ kind: "agent", id: "a1" });
		setAgentsMode("accordion");
		expect(state.dock).toEqual({ kind: "agents", id: "a1" });
		openAgent("a2");
		expect(state.dock).toEqual({ kind: "agents", id: "a2" });
		expect(expandedAgentId()).toBe("a2");
	});

	test("openAgents opens the list in single mode and the remembered row in accordion mode", () => {
		openAgents();
		expect(state.dock).toEqual({ kind: "agents" });
		closeDock();
		setAgentsMode("accordion");
		openAgents();
		expect(state.dock).toEqual({ kind: "agents" });
		toggleAgentExpanded("a1");
		closeDock();
		openAgents();
		expect(state.dock).toEqual({ kind: "agents", id: "a1" });
	});

	test("switching mode carries the selection both ways", () => {
		openAgent("a1");
		setAgentsMode("accordion");
		expect(state.dock).toEqual({ kind: "agents", id: "a1" });
		expect(expandedAgentId()).toBe("a1");
		setAgentsMode("single");
		expect(state.dock).toEqual({ kind: "agent", id: "a1" });
		expect(agentsMode()).toBe("single");
		expect(state.agentsExpanded).toBeUndefined();
	});

	test("switching mode with nothing selected keeps the list", () => {
		openDock("agents");
		setAgentsMode("accordion");
		expect(state.dock).toEqual({ kind: "agents" });
		setAgentsMode("single");
		expect(state.dock).toEqual({ kind: "agents" });
	});

	test("the accordion expands one agent at a time and collapses on a second click", () => {
		setAgentsMode("accordion");
		toggleAgentExpanded("a1");
		toggleAgentExpanded("a2");
		expect(expandedAgentId()).toBe("a2");
		toggleAgentExpanded("a2");
		expect(state.dock).toEqual({ kind: "agents" });
		expect(expandedAgentId()).toBeUndefined();
		expect(state.agentsExpanded).toBeUndefined();
	});

	test("the tree collapse set toggles per agent", () => {
		toggleAgentTreeCollapsed("a1");
		toggleAgentTreeCollapsed("a2");
		expect([...agentTreeCollapsed()]).toEqual(["a1", "a2"]);
		toggleAgentTreeCollapsed("a1");
		expect([...agentTreeCollapsed()]).toEqual(["a2"]);
	});
});

describe("route dock segment", () => {
	test("agent/<id> sets single mode and agents/<id> sets accordion mode", () => {
		applyRouteDock({ kind: "agents", id: "a1" });
		expect(agentsMode()).toBe("accordion");
		expect(state.dock).toEqual({ kind: "agents", id: "a1" });
		applyRouteDock({ kind: "agent", id: "a1" });
		expect(agentsMode()).toBe("single");
		expect(state.dock).toEqual({ kind: "agent", id: "a1" });
	});

	test("the bare agents list leaves the saved mode alone", () => {
		setAgentsMode("accordion");
		applyRouteDock({ kind: "agents" });
		expect(agentsMode()).toBe("accordion");
		expect(state.dock).toEqual({ kind: "agents" });
	});

	test("the mode set by the route is saved for the workspace", () => {
		applyRouteDock({ kind: "agents", id: "a1" });
		expect(readDockLayout("d1")).toMatchObject({
			mode: "accordion",
			dock: { kind: "agents", id: "a1" },
			expanded: "a1",
		});
	});
});

describe("per-workspace dock layout", () => {
	function attachWorkspace(id: string): void {
		dispatch(attached(id));
	}

	beforeEach(() => {
		installTransportStubs();
		setState({ currentSessionId: "" });
		connect();
		FakeWebSocket.instances.at(-1)?.onopen?.();
	});

	test("every change is saved to the attached workspace's record", () => {
		attachWorkspace("d1");
		openDock("review");
		expect(readDockLayout("d1").dock).toEqual({ kind: "review" });
		setAgentsMode("accordion");
		toggleAgentExpanded("a1");
		toggleAgentTreeCollapsed("a2");
		expect(readDockLayout("d1")).toEqual({
			dock: { kind: "agents", id: "a1" },
			mode: "accordion",
			filter: "all",
			expanded: "a1",
			treeCollapsed: ["a2"],
		});
		closeDock();
		expect(readDockLayout("d1")).toMatchObject({ dock: null, expanded: "a1" });
	});

	test("switching workspace restores that workspace's own dock, mode and tree state", () => {
		attachWorkspace("d1");
		openAgent("a1");
		setAgentsMode("accordion");
		toggleAgentTreeCollapsed("a2");

		attachWorkspace("d2");
		expect(state.dock).toBeNull();
		expect(agentsMode()).toBe("single");
		expect(state.agentsExpanded).toBeUndefined();
		expect(agentTreeCollapsed().size).toBe(0);
		openDock("tree");

		attachWorkspace("d1");
		expect(state.dock).toEqual({ kind: "agents", id: "a1" });
		expect(agentsMode()).toBe("accordion");
		expect([...agentTreeCollapsed()]).toEqual(["a2"]);

		attachWorkspace("d2");
		expect(state.dock).toEqual({ kind: "tree" });
		expect(agentsMode()).toBe("single");
	});

	test("the agents filter is saved for the attached workspace", () => {
		attachWorkspace("d1");
		expect(agentsFilter()).toBe("all");
		setAgentsFilter("running");
		expect(agentsFilter()).toBe("running");
		expect(readDockLayout("d1").filter).toBe("running");
		expect(state.dock).toBeNull();
	});

	test("switching workspace restores each workspace's own filter", () => {
		attachWorkspace("d1");
		setAgentsFilter("running");

		attachWorkspace("d2");
		expect(agentsFilter()).toBe("all");
		expect(readDockLayout("d2").filter).toBe("all");

		attachWorkspace("d1");
		expect(agentsFilter()).toBe("running");
		setAgentsFilter("all");
		attachWorkspace("d2");
		setAgentsFilter("running");
		attachWorkspace("d1");
		expect(agentsFilter()).toBe("all");
	});

	test("a saved record without a filter reads as all", () => {
		globalThis.localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({ d1: { dock: { kind: "tree" }, mode: "accordion", treeCollapsed: [] } }),
		);
		expect(readDockLayout("d1").filter).toBe("all");
		attachWorkspace("d1");
		expect(agentsFilter()).toBe("all");
		expect(agentsMode()).toBe("accordion");
	});

	test("an unknown saved filter reads as all", () => {
		globalThis.localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({ d1: { dock: null, mode: "single", filter: "bogus", treeCollapsed: [] } }),
		);
		expect(readDockLayout("d1").filter).toBe("all");
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

	test("a restored single agent id does not leak into a workspace with the plain list", () => {
		attachWorkspace("d1");
		openAgent("a1");
		attachWorkspace("d2");
		openDock("agents");
		attachWorkspace("d1");
		expect(state.dock).toEqual({ kind: "agent", id: "a1" });
		attachWorkspace("d2");
		expect(state.dock).toEqual({ kind: "agents" });
		expect(state.dock?.id).toBeUndefined();
	});

	test("nothing is saved while no workspace is attached", () => {
		openDock("review");
		expect(globalThis.localStorage.getItem(STORAGE_KEY)).toBeNull();
	});
});

describe("missing agent fallback", () => {
	test("is not decided while the forest is still loading", () => {
		openAgent("gone");
		reconcileMissingAgent();
		expect(state.dock).toEqual({ kind: "agent", id: "gone" });
		setState("subagentsLoaded", { mirror: true, roster: false });
		reconcileMissingAgent();
		expect(state.dock).toEqual({ kind: "agent", id: "gone" });
	});

	test("single mode falls back to the list and clears the remembered id", () => {
		openAgent("gone");
		loadForest();
		reconcileMissingAgent();
		expect(state.dock).toEqual({ kind: "agents" });
		expect(state.dock?.id).toBeUndefined();
		expect(readDockLayout("d1").dock).toEqual({ kind: "agents" });
	});

	test("accordion mode collapses all rows and clears the remembered id", () => {
		setAgentsMode("accordion");
		openAgent("gone");
		loadForest();
		reconcileMissingAgent();
		expect(state.dock).toEqual({ kind: "agents" });
		expect(state.agentsExpanded).toBeUndefined();
		expect(readDockLayout("d1").expanded).toBeUndefined();
	});

	test("a remembered id behind a closed dock is cleared too", () => {
		setAgentsMode("accordion");
		openAgent("gone");
		closeDock();
		loadForest();
		reconcileMissingAgent();
		expect(state.dock).toBeNull();
		expect(state.agentsExpanded).toBeUndefined();
	});

	test("an agent that is in the forest stays open", () => {
		seedAgents("a1");
		openAgent("a1");
		loadForest();
		reconcileMissingAgent();
		expect(state.dock).toEqual({ kind: "agent", id: "a1" });
	});
});

describe("pruning on roster removal", () => {
	function roster(...ids: string[]): void {
		setState(
			"daemonRoster",
			ids.map((daemonId) => ({ daemonId, status: "ready" }) as unknown as DaemonEntry),
		);
	}

	function saveFor(daemonId: string, kind = "review"): void {
		setState("currentSessionId", daemonId);
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
	test("unparseable storage reads as the default layout", () => {
		globalThis.localStorage.setItem(STORAGE_KEY, "{not json");
		expect(readDockLayout("d1")).toEqual({
			dock: null,
			mode: "single",
			filter: "all",
			treeCollapsed: [],
		});
	});

	test("unknown shapes fall back field by field", () => {
		globalThis.localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				d1: { dock: { kind: 7 }, mode: "wide", expanded: 4, treeCollapsed: "a1" },
				d2: {
					dock: { kind: "agents", id: "a1" },
					mode: "accordion",
					expanded: "a1",
					treeCollapsed: ["a2", 3, ""],
				},
				d3: "nope",
			}),
		);
		expect(readDockLayout("d1")).toEqual({
			dock: null,
			mode: "single",
			filter: "all",
			treeCollapsed: [],
		});
		expect(readDockLayout("d2")).toEqual({
			dock: { kind: "agents", id: "a1" },
			mode: "accordion",
			filter: "all",
			expanded: "a1",
			treeCollapsed: ["a2"],
		});
		expect(readDockLayout("d3")).toEqual({
			dock: null,
			mode: "single",
			filter: "all",
			treeCollapsed: [],
		});
	});

	test("storage that is not an object reads as no layouts", () => {
		globalThis.localStorage.setItem(STORAGE_KEY, "[1,2]");
		expect(readDockLayout("d1").dock).toBeNull();
	});
});
