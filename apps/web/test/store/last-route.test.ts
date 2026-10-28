/**
 * A launch with no hash (the installed app opens `start_url`) restores the
 * last attached route from localStorage, without ever waking an asleep or
 * user-stopped session. The route is remembered as the attached session writes it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RosterEntry } from "#lib/wire/protocol";
import { connect, setState } from "../../state";
import {
	LAST_ROUTE_KEY,
	resetDeepLink,
	restoreInitialRoute,
	syncRouteToAttached,
} from "../../store/deep-link";
import { clearUserStopped, markUserStopped } from "../../store/user-stopped";
import {
	attached,
	dispatch,
	FakeWebSocket,
	flushMicrotasks,
	installLocalStorageShim,
	installTransportStubs,
	posted,
	restoreBrowserGlobals,
	setBrowserGlobal,
} from "../web.testkit";

const written: string[] = [];

function rosterEntry(status: RosterEntry["status"]): RosterEntry {
	return { workspaceId: "d1", status } as unknown as RosterEntry;
}

function launch(hash: string, status: RosterEntry["status"]): void {
	(location as { hash: string }).hash = hash;
	setState({ view: "chat", sessionRoster: [rosterEntry(status)] });
	restoreInitialRoute();
}

beforeEach(() => {
	installTransportStubs();
	installLocalStorageShim();
	resetDeepLink();
	written.length = 0;
	setBrowserGlobal("location", {
		origin: "http://localhost",
		pathname: "/",
		search: "",
		hash: "",
	} as Location);
	setBrowserGlobal("history", {
		pushState: (_: unknown, __: string, url: string) => {
			written.push(`push ${url}`);
			(location as { hash: string }).hash = url.slice(url.indexOf("#"));
		},
		replaceState: (_: unknown, __: string, url: string) => {
			written.push(`replace ${url}`);
			(location as { hash: string }).hash = url.slice(url.indexOf("#"));
		},
	} as unknown as History);
	setState({ currentWorkspaceId: "", sessionId: "", modal: null });
	connect();
	FakeWebSocket.instances.at(-1)?.onopen?.();
	localStorage.setItem(LAST_ROUTE_KEY, JSON.stringify({ workspaceId: "d1", sessionId: "s1" }));
});

afterEach(() => {
	clearUserStopped("d1");
	restoreBrowserGlobals();
});

describe("no-hash launch", () => {
	test("a running last workspace is attached on whatever session it runs; the saved session id never switches it", async () => {
		launch("", "ready");
		await flushMicrotasks();
		const attach = posted.find((c) => c.type === "attach");
		if (attach?.type !== "attach") throw new Error("no attach was posted");
		expect(attach.workspaceId).toBe("d1");
		setState({ sessionId: "s2" }); // the process runs another session than the saved s1
		dispatch(attached("d1"));
		dispatch({ type: "attach_result", id: attach.id, ok: true, workspaceId: "d1" });
		for (let i = 0; i < 10; i++) await flushMicrotasks();
		expect(posted.some((c) => c.type === "list_workspace_sessions")).toBe(false);
		expect(posted.some((c) => c.type === "call" && c.method === "switchSession")).toBe(false);
		// The hash is filled in place (replace, never a push) with the session actually running.
		expect(written).toEqual(["replace /#/w/d1", "replace /#/w/d1/s/s2"]);
	});

	test("an asleep last session is never woken: nothing is sent and the saved route stays", async () => {
		launch("", "asleep");
		for (let i = 0; i < 5; i++) await flushMicrotasks();
		expect(posted).toEqual([]);
		expect(written).toEqual([]);
		expect(localStorage.getItem(LAST_ROUTE_KEY)).not.toBeNull();
	});

	test("a user-stopped last session is not attached", async () => {
		markUserStopped("d1");
		launch("", "ready");
		for (let i = 0; i < 5; i++) await flushMicrotasks();
		expect(posted).toEqual([]);
		expect(written).toEqual([]);
	});

	test("a last workspace that left the fleet is dropped without a hash write", async () => {
		(location as { hash: string }).hash = "";
		setState({ view: "chat", sessionRoster: [{ workspaceId: "other", status: "ready" } as never] });
		restoreInitialRoute();
		await flushMicrotasks();
		expect(posted).toEqual([]);
		expect(written).toEqual([]);
		expect(localStorage.getItem(LAST_ROUTE_KEY)).toBeNull();
	});

	test("a hash on the URL wins over the saved route", async () => {
		launch("#/w/d1", "ready");
		await flushMicrotasks();
		expect(written).toEqual([]);
		expect(localStorage.getItem(LAST_ROUTE_KEY)).toBe(
			JSON.stringify({ workspaceId: "d1", sessionId: "s1" }),
		);
	});
});

describe("remembering the route", () => {
	test("attaching a session saves its workspace and session id", () => {
		setState({ currentWorkspaceId: "d2", sessionId: "s9", dock: null });
		syncRouteToAttached();
		expect(JSON.parse(localStorage.getItem(LAST_ROUTE_KEY)!)).toEqual({
			workspaceId: "d2",
			sessionId: "s9",
		});
	});
});
