/**
 * `/handoff` settles only after a full-context LLM request writes the handoff
 * document, so it must outlive call()'s 30 second default deadline. Before the
 * fix it rejected at 30s ("The session did not answer in time") while the
 * session still committed the handoff in place.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ClientCommand, ServerFrame } from "#lib/wire/protocol";
import { LOCAL_COMMANDS } from "../prompt/commands";
import { connect, setState, state } from "../state";
import {
	MAINTENANCE_CALL_TIMEOUT_MS,
	pendingCalls,
	rejectPendingCalls,
	settleCallResult,
} from "../store/transport";
import {
	FakeEventSource,
	flushMicrotasks,
	installTransportStubs,
	posted,
	restoreBrowserGlobals,
	setBrowserGlobal,
} from "./web.testkit";

const START = 1_000_000;
let elapsed = 0;
type FakeTimer = { fn: () => void; due: number; delay: number; live: boolean };
const timers: FakeTimer[] = [];

beforeEach(async () => {
	installTransportStubs();
	timers.length = 0;
	elapsed = 0;
	setBrowserGlobal("window", {
		setTimeout: (fn: () => void, ms?: number) => {
			timers.push({ fn, due: elapsed + (ms ?? 0), delay: ms ?? 0, live: true });
			return timers.length;
		},
	} as unknown as Window & typeof globalThis);
	spyOn(globalThis, "clearTimeout").mockImplementation((id) => {
		const t = timers[Number(id) - 1];
		if (t) t.live = false;
	});
	spyOn(Date, "now").mockImplementation(() => START + elapsed);
	// Bootstrap fetches parse a JSON body; the testkit stub has none, so give it one.
	setBrowserGlobal("fetch", (async (_input: unknown, init?: RequestInit) => {
		if (typeof init?.body === "string") posted.push(JSON.parse(init.body) as ClientCommand);
		return { ok: true, status: 202, json: async () => ({}) } as unknown as Response;
	}) as unknown as typeof fetch);
	connect();
	FakeEventSource.instances.at(-1)!.onopen?.();
	// connect()'s own bootstrap fetches reject against the stub; drop that noise.
	await flushMicrotasks();
	setState("error", "");
});

afterEach(() => {
	mock.restore();
	rejectPendingCalls(new Error("test reset"));
	setState({ connected: false, sessionDownId: "", currentSessionId: "", error: "" });
});

afterAll(() => {
	restoreBrowserGlobals();
});

function pendingHandoffId(): string {
	const cmd = posted.findLast((c) => c.type === "call" && c.method === "handoff");
	if (cmd?.type !== "call") throw new Error("expected a handoff call");
	return cmd.id;
}

/** Timers the handoff call armed, by their requested delay. */
function armedDelays(since: number): number[] {
	return timers.slice(since).map((t) => t.delay);
}

describe("/handoff call deadline", () => {
	test("the call's deadline is the maintenance deadline, not call()'s 30s default", () => {
		const since = timers.length;
		LOCAL_COMMANDS.handoff?.("");
		pendingHandoffId();
		const delays = armedDelays(since);
		expect(delays).toContain(MAINTENANCE_CALL_TIMEOUT_MS);
		expect(delays).not.toContain(30_000);
	});

	test("a handoff still pending after 30s settles with its result and no error", async () => {
		const since = timers.length;
		LOCAL_COMMANDS.handoff?.("");
		const id = pendingHandoffId();
		// A 30s default deadline would fire here; the maintenance deadline has no 30s timer.
		for (const t of timers.slice(since)) {
			if (t.live && t.delay === 30_000) t.fn();
		}
		await flushMicrotasks();
		expect(pendingCalls.has(id)).toBe(true);
		expect(state.error).toBe("");

		const answer: ServerFrame = {
			type: "call_result",
			id,
			ok: true,
			data: { document: "# Handoff" },
		};
		settleCallResult(answer);
		await flushMicrotasks();
		expect(pendingCalls.has(id)).toBe(false);
		expect(state.error).toBe("");
	});

	test("an unanswered handoff still times out at the maintenance deadline", async () => {
		const since = timers.length;
		LOCAL_COMMANDS.handoff?.("");
		const id = pendingHandoffId();
		timers
			.slice(since)
			.find((t) => t.delay === MAINTENANCE_CALL_TIMEOUT_MS)
			?.fn();
		await flushMicrotasks();
		expect(pendingCalls.has(id)).toBe(false);
		expect(state.error).toBe("The session did not answer in time. Try again in a moment.");
	});
});
