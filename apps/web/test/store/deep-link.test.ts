/**
 * Store tests for the URL-to-session wiring (store/deep-link.ts). A fresh load
 * on a session hash must reattach that session and must not rewrite the URL to
 * the bare session route (that rewrite is what left the pane on "No active
 * session" and forced a re-pick from the resume list after a reload).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ClientCommand, RosterEntry } from "#lib/wire/protocol";
import { connect, setState } from "../../state";
import { restoreInitialRoute } from "../../store/deep-link";
import { settleWorkspaceSessions } from "../../store/roster";
import {
	FakeWebSocket,
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

beforeEach(() => {
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

describe("reload on a session hash", () => {
	test("reattaches the hashed session and keeps the session route", async () => {
		restoreInitialRoute();
		await flushMicrotasks();
		const list = posted.find((c) => c.type === "list_workspace_sessions");
		expect(list).toMatchObject({ workspaceId: "d1" });

		settleWorkspaceSessions("d1", [{ id: "s1", path: "/sessions/app/s1.jsonl" } as never]);
		await flushMicrotasks();
		await flushMicrotasks();

		const attach = posted.find((c): c is AttachCommand => c.type === "attach");
		expect(attach?.workspaceId).toBe("d1");
		if (attach === undefined) throw new Error("no attach command was posted");
		dispatch({ type: "attach_result", id: attach.id, ok: true, workspaceId: "d1" });
		await flushMicrotasks();
		// Attaching the session file re-attaches the session: answer that second attach too.
		const second = await untilPosted((c) => c.type === "attach" && c.id !== attach.id);
		if (second.type !== "attach") throw new Error("second attach was not an attach");
		dispatch({ type: "attach_result", id: second.id, ok: true, workspaceId: "d1" });
		const sw = await untilPosted((c) => c.type === "call" && c.method === "switchSession");
		if (sw.type !== "call") throw new Error("switchSession was not a call");
		dispatch(callResult(sw.id, undefined));
		// Drain the restore chain before afterEach restores location.
		for (let i = 0; i < 10; i++) await flushMicrotasks();

		expect(written.filter((url) => url.endsWith("#/w/d1"))).toEqual([]);
	});
});
