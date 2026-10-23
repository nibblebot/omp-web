/**
 * The dock across the URL and workspace switches (store/deep-link.ts +
 * store/dock.ts): a route that names a dock overrides the saved one and sets
 * the workspace's mode, a dock-less route closes the dock only within the
 * workspace the user is already on, and switching workspace restores that
 * workspace's saved dock without the route sync clobbering it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { ClientCommand, DaemonEntry } from "#lib/wire/protocol";
import { connect, setState, state } from "../../state";
import { onHashChange, restoreInitialRoute } from "../../store/deep-link";
import { persistDockLayout } from "../../prefs/dock-layout";
import { openDock } from "../../store/dock";
import { settleDaemonSessions } from "../../store/roster";
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
async function settleAttach(daemonId: string): Promise<void> {
	const attach = await untilPosted(
		(c): c is AttachCommand => c.type === "attach" && c.sessionId === daemonId,
	);
	if (attach.type !== "attach") throw new Error("not an attach command");
	dispatch(attached(daemonId));
	dispatch({ type: "attach_result", id: attach.id, ok: true, sessionId: daemonId });
	await drain();
}

function seedLayout(
	daemonId: string,
	dock: { kind: string; id?: string },
	mode: "single" | "accordion",
) {
	persistDockLayout(daemonId, {
		dock,
		mode,
		filter: "all",
		...(dock.kind === "agents" && dock.id !== undefined ? { expanded: dock.id } : {}),
		treeCollapsed: [],
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
	setState({ currentSessionId: "" });
	connect();
	FakeWebSocket.instances.at(-1)?.onopen?.();
	setState({
		modal: null,
		view: "chat",
		dock: null,
		agentsMode: "single",
		agentsExpanded: undefined,
		agentTreeCollapsed: new Set<string>(),
		daemonRoster: ["d1", "d2"].map(
			(daemonId) => ({ daemonId, status: "ready" }) as unknown as DaemonEntry,
		),
	});
	// Attached to d1 on session s1, as after a normal load.
	dispatch(attached("d1"));
	setState({ sessionId: "s1" });
});

afterEach(() => {
	setState({
		currentSessionId: "",
		sessionId: "",
		dock: null,
		agentsMode: "single",
		agentsExpanded: undefined,
	});
	restoreBrowserGlobals();
});

describe("within the attached workspace", () => {
	test("a route without a dock segment closes the dock", async () => {
		openDock("review");
		await navigate("#/d/d1/s/s1");
		expect(state.dock).toBeNull();
	});

	test("a route with agents/<id> opens the accordion with that agent", async () => {
		await navigate("#/d/d1/s/s1/agents/a1");
		expect(state.dock).toEqual({ kind: "agents", id: "a1" });
		expect(state.agentsMode).toBe("accordion");
	});

	test("a route with agent/<id> opens the single pane and sets single mode", async () => {
		setState("agentsMode", "accordion");
		await navigate("#/d/d1/s/s1/agent/a1");
		expect(state.dock).toEqual({ kind: "agent", id: "a1" });
		expect(state.agentsMode).toBe("single");
	});

	test("a bare agents route leaves the saved mode alone", async () => {
		setState("agentsMode", "accordion");
		await navigate("#/d/d1/s/s1/agents");
		expect(state.dock).toEqual({ kind: "agents" });
		expect(state.agentsMode).toBe("accordion");
	});
});

describe("switching to another workspace", () => {
	test("a dock-less daemon route restores the saved dock and mode of the target", async () => {
		openDock("review");
		seedLayout("d2", { kind: "agents", id: "a7" }, "accordion");
		await navigate("#/d/d2");
		await settleAttach("d2");
		expect(state.currentSessionId).toBe("d2");
		expect(state.dock).toEqual({ kind: "agents", id: "a7" });
		expect(state.agentsMode).toBe("accordion");
	});

	test("the saved dock of a workspace without one stays closed", async () => {
		openDock("review");
		await navigate("#/d/d2");
		await settleAttach("d2");
		expect(state.dock).toBeNull();
	});

	test("a route that carries a dock overrides the saved one and sets the mode", async () => {
		seedLayout("d2", { kind: "agents", id: "a7" }, "accordion");
		await navigate("#/d/d2/s/s2/agent/a1");
		const list = await untilPosted((c) => c.type === "list_daemon_sessions");
		expect(list).toMatchObject({ daemonId: "d2" });
		settleDaemonSessions("d2", [{ id: "s2", path: "/sessions/s2.jsonl" } as never]);
		await settleAttach("d2");
		const sw = await untilPosted((c) => c.type === "call" && c.method === "switchSession");
		if (sw.type !== "call") throw new Error("switchSession was not a call");
		dispatch(callResult(sw.id, undefined));
		await drain();
		expect(state.dock).toEqual({ kind: "agent", id: "a1" });
		expect(state.agentsMode).toBe("single");
	});
});
