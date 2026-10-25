/**
 * The dock across the URL and workspace switches (store/deep-link.ts +
 * store/dock.ts + store/activities.ts): a route that names a dock overrides
 * the saved one (an item route opens in the workspace's saved mode; the mode
 * itself is never in the URL), a dock-less route closes the dock only within
 * the workspace the user is already on, and switching workspace restores that
 * workspace's saved dock without the route sync clobbering it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { ClientCommand, RosterEntry } from "#lib/wire/protocol";
import { connect, setState, state } from "../../state";
import { onHashChange, restoreInitialRoute, syncRouteToAttached } from "../../store/deep-link";
import { defaultActivitiesLayout, persistDockLayout } from "../../prefs/dock-layout";
import { openItemDetail, setActivitiesMode } from "../../store/activities";
import { openDock, restoreDockLayout } from "../../store/dock";
import { settleWorkspaceSessions } from "../../store/roster";
import {
	attached,
	callResult,
	dispatch,
	FakeWebSocket,
	flushMicrotasks,
	installLocalStorageShim,
	installTransportStubs,
	posted,
	restoreBrowserGlobals,
	setBrowserGlobal,
} from "../web.testkit";

type AttachCommand = Extract<ClientCommand, { type: "attach" }>;

const written: string[] = [];
const loc = { origin: "http://localhost", pathname: "/", search: "", hash: "" };

async function untilPosted(
	match: (c: (typeof posted)[number]) => boolean,
): Promise<(typeof posted)[number]> {
	for (let i = 0; i < 50; i++) {
		const hit = posted.find(match);
		if (hit !== undefined) return hit;
		await flushMicrotasks();
	}
	throw new Error("expected command was not posted");
}

async function drain(): Promise<void> {
	for (let i = 0; i < 10; i++) await flushMicrotasks();
}

/** Navigate to a hash as Back/Forward or a pasted link does. */
async function navigate(hash: string): Promise<void> {
	loc.hash = hash;
	onHashChange();
	await drain();
}

/** Answer the attach the navigation posted: the proxied `attached` frame, then the id-keyed result. */
async function settleAttach(workspaceId: string): Promise<void> {
	const attach = await untilPosted(
		(c): c is AttachCommand => c.type === "attach" && c.workspaceId === workspaceId,
	);
	if (attach.type !== "attach") throw new Error("not an attach command");
	dispatch(attached(workspaceId));
	dispatch({ type: "attach_result", id: attach.id, ok: true, workspaceId: workspaceId });
	await drain();
}

function seedLayout(workspaceId: string, dock: { kind: string }, mode: "accordion" | "detail") {
	persistDockLayout(workspaceId, {
		dock,
		activities: { ...defaultActivitiesLayout(), mode },
	});
}

beforeAll(() => {
	installLocalStorageShim();
	setBrowserGlobal("location", loc as unknown as Location);
	restoreInitialRoute(); // consumed with an empty hash: later navigations go through onHashChange
});

beforeEach(() => {
	installTransportStubs();
	installLocalStorageShim();
	written.length = 0;
	loc.hash = "";
	setBrowserGlobal("location", loc as unknown as Location);
	setBrowserGlobal("history", {
		pushState: (_: unknown, __: string, url: string) => written.push(`push ${url}`),
		replaceState: (_: unknown, __: string, url: string) => written.push(`replace ${url}`),
	} as unknown as History);
	setState({ currentWorkspaceId: "" });
	connect();
	FakeWebSocket.instances.at(-1)?.onopen?.();
	setState({
		modal: null,
		view: "chat",
		sessionRoster: ["d1", "d2"].map(
			(workspaceId) => ({ workspaceId, status: "ready" }) as unknown as RosterEntry,
		),
	});
	// Attached to d1 on session s1, as after a normal load.
	dispatch(attached("d1"));
	setState({ sessionId: "s1" });
	restoreDockLayout("__no-such-workspace__");
});

afterEach(() => {
	restoreDockLayout("__no-such-workspace__");
	setState({ currentWorkspaceId: "", sessionId: "" });
	restoreBrowserGlobals();
});

describe("within the attached workspace", () => {
	test("a route without a dock segment closes the dock", async () => {
		openDock("review");
		await navigate("#/w/d1/s/s1");
		expect(state.dock).toBeNull();
	});

	test("an item route expands the item in the accordion", async () => {
		await navigate("#/w/d1/s/s1/activities/subagent/a1");
		expect(state.dock).toEqual({ kind: "activities" });
		expect(state.activities.mode).toBe("accordion");
		expect(state.activities.expanded.subagents.has("a1")).toBe(true);
		expect(state.activities.detail).toBeUndefined();
	});

	test("an item route fills the panel when the saved mode is detail, and the URL follows it", async () => {
		setActivitiesMode("detail");
		await navigate("#/w/d1/s/s1/activities/job/j1");
		expect(state.dock).toEqual({ kind: "activities", item: { type: "job", id: "j1" } });
		expect(state.activities.mode).toBe("detail");
		expect(state.activities.detail).toEqual({ section: "jobs", id: "j1" });

		written.length = 0;
		loc.hash = "#/w/d1/s/s1";
		openItemDetail({ section: "subagents", id: "a 1" });
		syncRouteToAttached();
		expect(written.at(-1)).toBe("push /#/w/d1/s/s1/activities/subagent/a%201");
	});

	test("a bare activities route opens the panel on its list and leaves the saved mode alone", async () => {
		setActivitiesMode("detail");
		await navigate("#/w/d1/s/s1/activities/subagent/a1");
		await navigate("#/w/d1/s/s1/activities");
		expect(state.dock).toEqual({ kind: "activities" });
		expect(state.activities.detail).toBeUndefined();
		expect(state.activities.mode).toBe("detail");
	});

	test("a workspace-level route (no session segment) opens the dock and the item", async () => {
		await navigate("#/w/d1/activities/subagent/a1");
		expect(state.dock).toEqual({ kind: "activities" });
		expect(state.activities.expanded.subagents.has("a1")).toBe(true);
		expect(state.currentWorkspaceId).toBe("d1");
	});

	test("the legacy agents segments are not understood and change nothing", async () => {
		openDock("review");
		await navigate("#/w/d1/s/s1/agents/a1");
		await navigate("#/w/d1/s/s1/agent/a1");
		expect(state.dock).toEqual({ kind: "review" });
		expect(state.activities.expanded.subagents.size).toBe(0);
	});
});

describe("switching to another workspace", () => {
	test("a dock-less route restores the saved dock and layout of the target", async () => {
		openDock("review");
		seedLayout("d2", { kind: "activities" }, "detail");
		await navigate("#/w/d2");
		await settleAttach("d2");
		expect(state.currentWorkspaceId).toBe("d2");
		expect(state.dock).toEqual({ kind: "activities" });
		expect(state.activities.mode).toBe("detail");
	});

	test("the saved dock of a workspace without one stays closed", async () => {
		openDock("review");
		await navigate("#/w/d2");
		await settleAttach("d2");
		expect(state.dock).toBeNull();
	});

	test("a route that carries an item overrides the saved dock and opens it in the target's saved mode", async () => {
		seedLayout("d2", { kind: "review" }, "detail");
		await navigate("#/w/d2/s/s2/activities/subagent/a1");
		const list = await untilPosted((c) => c.type === "list_workspace_sessions");
		expect(list).toMatchObject({ workspaceId: "d2" });
		settleWorkspaceSessions("d2", [{ id: "s2", path: "/sessions/s2.jsonl" } as never]);
		await settleAttach("d2");
		const sw = await untilPosted((c) => c.type === "call" && c.method === "switchSession");
		if (sw.type !== "call") throw new Error("switchSession was not a call");
		dispatch(callResult(sw.id, undefined));
		await drain();
		expect(state.dock).toEqual({ kind: "activities", item: { type: "subagent", id: "a1" } });
		expect(state.activities.mode).toBe("detail");
		expect(state.activities.detail).toEqual({ section: "subagents", id: "a1" });
	});
});
