/**
 * `list_files` / `list_sessions` answers are matched to their request by the
 * command id the frame echoes: a late answer to a superseded request must not
 * settle the newer request, which keeps waiting for its own answer.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ClientCommand, SessionListEntry } from "#lib/wire/protocol";
import { connect, listFiles, listSessions, resetBrowserSocket } from "../../state";
import {
	FakeWebSocket,
	dispatch,
	flushMicrotasks,
	installTransportStubs,
	posted,
	restoreBrowserGlobals,
} from "../web.testkit";

type ListFiles = Extract<ClientCommand, { type: "list_files" }>;
type ListSessions = Extract<ClientCommand, { type: "list_sessions" }>;

function sent<T extends ClientCommand["type"]>(type: T): Extract<ClientCommand, { type: T }>[] {
	return posted.filter((c): c is Extract<ClientCommand, { type: T }> => c.type === type);
}

function sessionEntry(id: string): SessionListEntry {
	return {
		path: `/s/${id}.jsonl`,
		id,
		cwd: "/w",
		modifiedAt: 1,
		messageCount: 1,
		firstMessage: id,
	};
}

beforeEach(() => {
	installTransportStubs();
	connect();
	FakeWebSocket.instances.at(-1)?.onopen?.();
});

afterEach(() => {
	resetBrowserSocket();
	restoreBrowserGlobals();
});

describe("list_files answers", () => {
	test("a late answer to an older query does not settle the newer query", async () => {
		const older = listFiles("src/a");
		const newer = listFiles("src/ab");
		const [first, second] = sent("list_files") as [ListFiles, ListFiles];
		let newerSettled = false;
		void newer.then(() => (newerSettled = true));

		// The older request was superseded: it resolved empty at once.
		expect(await older).toEqual([]);

		// Its answer arrives after the newer request was sent.
		dispatch({ type: "files", id: first.id, files: ["src/a.ts"] });
		await flushMicrotasks();
		expect(newerSettled).toBe(false);

		dispatch({ type: "files", id: second.id, files: ["src/ab.ts"] });
		expect(await newer).toEqual(["src/ab.ts"]);
	});

	test("an answer for an unknown id is ignored", async () => {
		const request = listFiles("x");
		let settled = false;
		void request.then(() => (settled = true));
		dispatch({ type: "files", id: "someone-elses", files: ["nope.ts"] });
		await flushMicrotasks();
		expect(settled).toBe(false);
		const [cmd] = sent("list_files") as [ListFiles];
		dispatch({ type: "files", id: cmd.id, files: ["x.ts"] });
		expect(await request).toEqual(["x.ts"]);
	});
});

describe("list_sessions answers", () => {
	test("a late answer to a superseded request does not settle the newer one", async () => {
		const older = listSessions();
		const newer = listSessions();
		const [first, second] = sent("list_sessions") as [ListSessions, ListSessions];
		let newerSettled = false;
		void newer.then(() => (newerSettled = true));
		expect(await older).toEqual([]);

		dispatch({ type: "sessions", id: first.id, sessions: [sessionEntry("old")] });
		await flushMicrotasks();
		expect(newerSettled).toBe(false);

		dispatch({ type: "sessions", id: second.id, sessions: [sessionEntry("new")] });
		expect((await newer).map((s) => s.id)).toEqual(["new"]);
	});
});

describe("answers from a session that predates the echoed id", () => {
	test("an id-less files answer settles the latest pending request", async () => {
		void listFiles("old");
		const latest = listFiles("new");
		dispatch({ type: "files", files: ["new.ts"] });
		expect(await latest).toEqual(["new.ts"]);
	});

	test("an id-less sessions answer settles the latest pending request", async () => {
		const request = listSessions();
		dispatch({ type: "sessions", sessions: [sessionEntry("legacy")] });
		expect((await request).map((s) => s.id)).toEqual(["legacy"]);
	});

	test("an id-less answer with nothing pending is ignored", async () => {
		dispatch({ type: "files", files: ["stray.ts"] });
		const request = listFiles("x");
		let settled = false;
		void request.then(() => (settled = true));
		await flushMicrotasks();
		expect(settled).toBe(false);
	});
});
