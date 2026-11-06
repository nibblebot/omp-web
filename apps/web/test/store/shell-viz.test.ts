/** The shell visualization fetch: what a call sends, the stale-workspace guard, and the remembered misses. */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ShellVizDto } from "#lib/wire/protocol";
import * as transport from "../../store/transport";

let handler: (method: string, args: unknown[]) => Promise<unknown> = async () => undefined;
const originalTransport = { ...transport };
mock.module("../../store/transport", () => ({
	...originalTransport,
	call: (method: string, args: unknown[]) => handler(method, args),
}));
afterAll(() => {
	mock.module("../../store/transport", () => originalTransport);
});

const store = await import("../../store/shell-viz");
const { setState, state } = await import("../../state");
const originalSession = state.currentWorkspaceId;

const ready: ShellVizDto = {
	available: true,
	running: false,
	status: 0,
	pseudo: [],
	raw: [],
	timeline: { length: 0, cursor: 0, elapsedNs: 0, durationNs: 0 },
};

let calls: Array<{ method: string; args: unknown[] }> = [];
beforeEach(() => {
	calls = [];
	store.forgetShellVizUnavailable();
	setState("currentWorkspaceId", "sess-a");
	handler = async (method, args) => {
		calls.push({ method, args });
		return ready;
	};
});
afterAll(() => setState("currentWorkspaceId", originalSession));

describe("fetchShellViz", () => {
	test("asks for the call by id, naming the subagent and the replay cursor only when given", async () => {
		await store.fetchShellViz("c1", undefined);
		await store.fetchShellViz("c2", "agent-1", 5);
		expect(calls).toEqual([
			{ method: "getShellVisualization", args: [{ toolCallId: "c1" }] },
			{
				method: "getShellVisualization",
				args: [{ toolCallId: "c2", subagentId: "agent-1", cursor: 5 }],
			},
		]);
	});

	test("returns the session's answer, unavailable ones included", async () => {
		expect(await store.fetchShellViz("c1", undefined)).toEqual(ready);
		handler = async () => ({ available: false, reason: "no_trace" });
		expect(await store.fetchShellViz("c1", undefined)).toEqual({
			available: false,
			reason: "no_trace",
		});
	});

	test("an answer that lands after the workspace changed is dropped", async () => {
		const gate = Promise.withResolvers<unknown>();
		handler = () => gate.promise;
		const pending = store.fetchShellViz("c1", undefined);
		setState("currentWorkspaceId", "sess-b");
		gate.resolve(ready);
		expect(await pending).toBeNull();
	});

	test("a transport failure rejects for the card to show", async () => {
		handler = async () => {
			throw new Error("Not connected");
		};
		await expect(store.fetchShellViz("c1", undefined)).rejects.toThrow("Not connected");
	});
});

describe("remembered misses", () => {
	test("a miss hides that call only, and only in its workspace", () => {
		const key = store.shellVizKey("c1");
		expect(store.shellVizUnavailable(key)).toBe(false);
		store.rememberShellVizUnavailable(key);
		expect(store.shellVizUnavailable(key)).toBe(true);
		expect(store.shellVizUnavailable(store.shellVizKey("c2"))).toBe(false);
		expect(store.shellVizUnavailable(store.shellVizKey("c1", "agent-1"))).toBe(false);
		setState("currentWorkspaceId", "sess-b");
		expect(store.shellVizUnavailable(store.shellVizKey("c1"))).toBe(false);
	});

	test("the memory is bounded: the oldest miss goes first", () => {
		for (let i = 0; i < 501; i++) store.rememberShellVizUnavailable(store.shellVizKey(`c${i}`));
		expect(store.shellVizUnavailable(store.shellVizKey("c0"))).toBe(false);
		expect(store.shellVizUnavailable(store.shellVizKey("c500"))).toBe(true);
	});
});
