/**
 * Store tests for the URL-to-session wiring (store/deep-link.ts). A fresh load
 * on a session hash must reattach that session and must not rewrite the URL to
 * the bare session route (that rewrite is what left the pane on "No active
 * session" and forced a re-pick from the resume list after a reload).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ClientCommand, RosterEntry, WebSessionState } from "#lib/wire/protocol";
import { connect, setState } from "../../state";
import type * as DeepLink from "../../store/deep-link";
import { settleWorkspaceSessions } from "../../store/roster";
import {
	FakeWebSocket,
	attached,
	callResult,
	dispatch,
	flushMicrotasks,
	installLocalStorageShim,
	installTransportStubs,
	posted,
	restoreBrowserGlobals,
	setBrowserGlobal,
} from "../web.testkit";

type AttachCommand = Extract<ClientCommand, { type: "attach" }>;

const written: string[] = [];

// The initial restore runs once per module load, so each test loads a fresh copy.
let restoreInitialRoute: typeof DeepLink.restoreInitialRoute;
let loads = 0;

/** Yield microtasks until a matching command is posted. Bounded; no timers. */
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

beforeEach(async () => {
	const path: string = `../../store/deep-link.ts?fresh=${++loads}`;
	({ restoreInitialRoute } = (await import(path)) as typeof DeepLink);
	installTransportStubs();
	installLocalStorageShim();
	written.length = 0;
	setBrowserGlobal("location", {
		origin: "http://localhost",
		pathname: "/",
		search: "",
		hash: "#/w/d1/s/s1",
	} as Location);
	setBrowserGlobal("history", {
		pushState: (_: unknown, __: string, url: string) => written.push(`push ${url}`),
		replaceState: (_: unknown, __: string, url: string) => written.push(`replace ${url}`),
	} as unknown as History);
	// A reloaded page has no attached session yet: the socket's open must not re-attach one a sibling file left.
	setState({ currentWorkspaceId: "" });
	connect();
	FakeWebSocket.instances.at(-1)?.onopen?.();
	setState({
		modal: null,
		view: "chat",
		sessionRoster: [{ workspaceId: "d1", status: "ready" } as unknown as RosterEntry],
	});
});

afterEach(() => {
	restoreBrowserGlobals();
});

/** Answer the attach the restore posts and deliver the frames a live session process sends for it. */
async function answerAttach(sessionId: string): Promise<void> {
	const attach = await untilPosted((c): c is AttachCommand => c.type === "attach");
	if (attach.type !== "attach") throw new Error("no attach command was posted");
	expect(attach.workspaceId).toBe("d1");
	dispatch({ type: "attach_result", id: attach.id, ok: true, workspaceId: "d1" });
	dispatch(attached("d1"));
	dispatch({
		type: "state",
		state: {
			sessionId,
			sessionScope: { workspaceId: "d1", sessionId, generation: "1" },
		} as WebSessionState,
	});
	await flushMicrotasks();
}

describe("reload on a session hash", () => {
	test("attaches the live process without listing its sessions when it is on the hashed session", async () => {
		restoreInitialRoute();
		await answerAttach("s1");
		// Drain the restore chain before afterEach restores location.
		for (let i = 0; i < 10; i++) await flushMicrotasks();

		expect(posted.some((c) => c.type === "list_workspace_sessions")).toBe(false);
		expect(posted.some((c) => c.type === "call" && c.method === "switchSession")).toBe(false);
		expect(written.filter((url) => url.endsWith("#/w/d1"))).toEqual([]);
	});

	test("lists the sessions and switches when the live process is on another session", async () => {
		restoreInitialRoute();
		await answerAttach("other");
		const list = await untilPosted((c) => c.type === "list_workspace_sessions");
		expect(list).toMatchObject({ workspaceId: "d1" });

		settleWorkspaceSessions("d1", [{ id: "s1", path: "/sessions/app/s1.jsonl" } as never]);
		const sw = await untilPosted((c) => c.type === "call" && c.method === "switchSession");
		if (sw.type !== "call") throw new Error("switchSession was not a call");
		dispatch(callResult(sw.id, undefined));
		// Drain the restore chain before afterEach restores location.
		for (let i = 0; i < 10; i++) await flushMicrotasks();

		expect(written.filter((url) => url.endsWith("#/w/d1"))).toEqual([]);
	});
});
