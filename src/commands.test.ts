import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	dispatchInput,
	exportDispatch,
	goalDispatch,
	handoffArgs,
	LOCAL_COMMANDS,
	parseInput,
	planDispatch,
	queueMethod,
	renameDispatch,
} from "./commands";
import { SSE_EVENT_NAME } from "../shared/protocol";
import type { ClientCommand, ServerFrame } from "../shared/protocol";
import {
	addBashItem,
	appendBashChunk,
	call,
	connect,
	resolveBashItem,
	setState,
	state,
	type ChatItem,
} from "./state";
import {
	cancelDangerConfirm,
	confirmDangerConfirm,
	dangerConfirm,
} from "./components/ConfirmDialog";

describe("parseInput", () => {
	test("plain text", () => {
		expect(parseInput("hello world")).toEqual({ kind: "text" });
	});

	test("bang-shell, normal and dimmed", () => {
		expect(parseInput("!ls -la")).toEqual({ kind: "bash", command: "ls -la", dimmed: false });
		expect(parseInput("!!secret")).toEqual({ kind: "bash", command: "secret", dimmed: true });
	});

	test("python-shell, normal and excluded", () => {
		expect(parseInput("$print(2+2)")).toEqual({
			kind: "python",
			code: "print(2+2)",
			dimmed: false,
		});
		expect(parseInput("$$print('secret')")).toEqual({
			kind: "python",
			code: "print('secret')",
			dimmed: true,
		});
	});

	test("$$ is not $ with an extra $; both trim surrounding space", () => {
		expect(parseInput("$ print(2+2)")).toEqual({
			kind: "python",
			code: "print(2+2)",
			dimmed: false,
		});
		expect(parseInput("$$  print(1)")).toEqual({ kind: "python", code: "print(1)", dimmed: true });
	});

	test("lone $ is an empty python call, not text", () => {
		expect(parseInput("$")).toEqual({ kind: "python", code: "", dimmed: false });
		expect(parseInput("$$")).toEqual({ kind: "python", code: "", dimmed: true });
	});

	test("slash with and without args", () => {
		expect(parseInput("/compact focus on api")).toEqual({
			kind: "slash",
			name: "compact",
			args: "focus on api",
		});
		expect(parseInput("/new")).toEqual({ kind: "slash", name: "new", args: "" });
	});

	test("slash name is case-insensitive", () => {
		expect(parseInput("/HELP")).toEqual({ kind: "slash", name: "help", args: "" });
	});

	test("lone prefixes are not bash/slash", () => {
		expect(parseInput("!")).toEqual({ kind: "bash", command: "", dimmed: false });
		expect(parseInput("not /a command")).toEqual({ kind: "text" });
	});
});

describe("queue shorthand", () => {
	test("-> forces steer-queue, prefix stripped", () => {
		expect(parseInput("-> fix the typo")).toEqual({
			kind: "queue",
			steering: true,
			text: "fix the typo",
		});
	});

	test("=> forces follow-up queue, prefix stripped", () => {
		expect(parseInput("=> after this, summarize")).toEqual({
			kind: "queue",
			steering: false,
			text: "after this, summarize",
		});
	});

	test("prefixes without a trailing space stay plain text", () => {
		expect(parseInput("->nospace")).toEqual({ kind: "text" });
		expect(parseInput("=>nospace")).toEqual({ kind: "text" });
		expect(parseInput("a -> b")).toEqual({ kind: "text" });
	});

	test("method selection respects streaming state", () => {
		expect(queueMethod(true, true)).toBe("steer");
		// Idle fallback: steer errors on an idle session, Enter sends a prompt.
		expect(queueMethod(true, false)).toBe("prompt");
		expect(queueMethod(false, true)).toBe("followUp");
		expect(queueMethod(false, false)).toBe("followUp");
	});

	test("/queue is a local follow-up command", () => {
		expect(LOCAL_COMMANDS.queue).toBeFunction();
	});
});

describe("LOCAL_COMMANDS table", () => {
	test("covers the Phase 2 web-local set", () => {
		for (const name of ["new", "clear", "compact", "help", "hotkeys", "exit", "quit"]) {
			expect(LOCAL_COMMANDS[name]).toBeFunction();
		}
	});

	test("covers the Phase 8 session-command set", () => {
		for (const name of ["retry", "fork", "fresh", "handoff", "drop", "dump", "rename"]) {
			expect(LOCAL_COMMANDS[name]).toBeFunction();
		}
	});
});

describe("session command parsing", () => {
	test("/rename with a title renames directly, no LLM round-trip", () => {
		expect(renameDispatch("My Session")).toEqual({ method: "setSessionName", title: "My Session" });
		expect(renameDispatch("  padded title  ")).toEqual({
			method: "setSessionName",
			title: "padded title",
		});
	});

	test("bare /rename keeps the agent auto-title passthrough", () => {
		expect(renameDispatch("")).toEqual({ method: "prompt", text: "/rename" });
		expect(renameDispatch("   ")).toEqual({ method: "prompt", text: "/rename" });
	});

	test("/handoff joins free-text focus into one optional instructions arg", () => {
		expect(handoffArgs("focus on the api layer")).toEqual(["focus on the api layer"]);
		expect(handoffArgs("")).toEqual([undefined]);
		expect(handoffArgs("   ")).toEqual([undefined]);
	});
});

describe("goal/plan local commands", () => {
	test("LOCAL_COMMANDS covers goal and plan", () => {
		expect(LOCAL_COMMANDS.goal).toBeFunction();
		expect(LOCAL_COMMANDS.plan).toBeFunction();
	});

	test("parseInput classifies /goal and /plan as slash (local dispatch gate, not passthrough)", () => {
		expect(parseInput("/goal set implement the API")).toEqual({
			kind: "slash",
			name: "goal",
			args: "set implement the API",
		});
		expect(parseInput("/goal pause")).toEqual({ kind: "slash", name: "goal", args: "pause" });
		expect(parseInput("/plan")).toEqual({ kind: "slash", name: "plan", args: "" });
	});

	test("/goal subcommands route to goalRuntime relay rows", () => {
		expect(goalDispatch("set implement the API")).toEqual({
			kind: "call",
			method: "goalCreate",
			args: ["implement the API"],
		});
		expect(goalDispatch("set   padded   objective  ")).toEqual({
			kind: "call",
			method: "goalCreate",
			args: ["padded objective"],
		});
		expect(goalDispatch("pause")).toEqual({ kind: "call", method: "goalPause", args: [] });
		expect(goalDispatch("resume")).toEqual({ kind: "call", method: "goalResume", args: [] });
		expect(goalDispatch("drop")).toEqual({ kind: "call", method: "goalDrop", args: [] });
	});

	test("bare or unknown /goal opens the popover instead of prompting", () => {
		expect(goalDispatch("")).toEqual({ kind: "popover" });
		expect(goalDispatch("   ")).toEqual({ kind: "popover" });
		expect(goalDispatch("set")).toEqual({ kind: "popover" });
		expect(goalDispatch("wat")).toEqual({ kind: "popover" });
	});

	test("/plan toggles planModeEnabled via setPlanModeState", () => {
		const before = state.planModeEnabled;
		expect(planDispatch().args[0].enabled).toBe(!before);
		expect(planDispatch().args[0].planFilePath).toBe("");
		// Flip the store and confirm the toggle inverts.
		setState("planModeEnabled", !before);
		expect(planDispatch().args[0].enabled).toBe(before);
		// Restore for sibling tests.
		setState("planModeEnabled", before);
	});
});

describe("Phase 11 web-plus commands", () => {
	test("parseInput classifies /btw with and without a question", () => {
		expect(parseInput("/btw")).toEqual({ kind: "slash", name: "btw", args: "" });
		expect(parseInput("/btw what does this function do")).toEqual({
			kind: "slash",
			name: "btw",
			args: "what does this function do",
		});
		// parseInput keeps the trailing space verbatim (dispatchInput trims).
		expect(parseInput("/BTW  explain  main() ")).toEqual({
			kind: "slash",
			name: "btw",
			args: "explain  main() ",
		});
	});

	test("LOCAL_COMMANDS covers the Phase 11 set", () => {
		expect(LOCAL_COMMANDS.btw).toBeFunction();
		expect(LOCAL_COMMANDS.export).toBeFunction();
	});

	test("/export --themes passes useUserThemes, bare /export does not", () => {
		expect(exportDispatch("--themes")).toEqual({ useThemes: true });
		expect(exportDispatch("  --themes  ")).toEqual({ useThemes: true });
		expect(exportDispatch("--themes --verbose")).toEqual({ useThemes: true });
		expect(exportDispatch("")).toEqual({ useThemes: false });
		expect(exportDispatch("--verbose")).toEqual({ useThemes: false });
		expect(exportDispatch("themes")).toEqual({ useThemes: false });
	});
});

// ---------------------------------------------------------------------------
// Finding #29: bang-shell/python calls must not time out at 30s. Chunks
// (bash_chunk/python_chunk) provide liveness, abortBash/abortEval are the
// cancellation path, and a client-side timer stranded the server-side result:
// the promise rejected, resolveBashItem wiped the streamed output, and the
// late call_result found no pending entry. call(timeoutMs=0) arms no timer.
// ---------------------------------------------------------------------------
// Transport doubles mirroring state.test.ts: connect() registers its SSE
// handler on a FakeEventSource; POST /command bodies land in `posted` via a
// stubbed fetch. The controllable clock records the ONLY window.setTimeout
// consumer (call()'s timeout timer), so tests can advance past the old 30s
// default and prove nothing fires.
type SseHandler = (ev: { data: string }) => void;

class FakeEventSource {
	static instances: FakeEventSource[] = [];
	static handlers = new Map<string, SseHandler>();
	onopen: (() => void) | null = null;
	constructor(public readonly url: string) {
		FakeEventSource.instances.push(this);
	}
	addEventListener(type: string, handler: SseHandler): void {
		FakeEventSource.handlers.set(type, handler);
	}
	close(): void {}
	static dispatch(type: string, data: string): void {
		FakeEventSource.handlers.get(type)?.({ data });
	}
}

const posted: ClientCommand[] = [];

function dispatch(frame: ServerFrame): void {
	FakeEventSource.dispatch(SSE_EVENT_NAME, JSON.stringify(frame));
}

function callResult(id: string, data: unknown): ServerFrame {
	return { type: "call_result", id, ok: true, data };
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

const timers: { fn: () => void; ms: number; fired: boolean }[] = [];

function installClock(): void {
	timers.length = 0;
	globalThis.window = {
		setTimeout: (fn: () => void, ms?: number) => {
			timers.push({ fn, ms: ms ?? 0, fired: false });
			return timers.length;
		},
		clearTimeout: () => {},
	} as unknown as Window & typeof globalThis;
}

function advance(ms: number): void {
	for (const t of [...timers]) {
		if (!t.fired && t.ms <= ms) {
			t.fired = true;
			t.fn();
		}
	}
}

beforeEach(() => {
	posted.length = 0;
	timers.length = 0;
	FakeEventSource.instances.length = 0;
	FakeEventSource.handlers.clear();
	installClock();
	globalThis.location = { search: "" } as Location;
	globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
	globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
		if (typeof init?.body === "string") posted.push(JSON.parse(init.body) as ClientCommand);
		return { ok: true, status: 202 } as Response;
	}) as unknown as typeof fetch;
	setState({
		currentSessionId: "",
		sessionMode: "single",
		connected: false,
		readyAt: undefined,
		subagents: new Map(),
		items: [],
	});
});

// The transport stubs are global and would otherwise leak into sibling test
// files run in the same worker (a bun test worker can run several files);
// restore the originals once this file's own tests are done.
const originalLocation = globalThis.location;
const originalWindow = globalThis.window;
const originalEventSource = globalThis.EventSource;
const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.location = originalLocation;
	globalThis.window = originalWindow;
	globalThis.EventSource = originalEventSource;
	globalThis.fetch = originalFetch;
});

describe("bang-shell/python stream lifecycle (#29)", () => {
	function startBang(input: string, method: "bash" | "python") {
		connect();
		const es = FakeEventSource.instances.at(-1);
		expect(es).toBeDefined();
		es!.onopen?.(); // connected = true; without this call() fails fast
		dispatchInput(input, undefined, "enter");
		const postedCall = posted.find(
			(c): c is Extract<ClientCommand, { type: "call" }> =>
				c.type === "call" && c.method === method,
		);
		expect(postedCall).toBeDefined();
		expect(postedCall!.streamId).toBeDefined();
		const itemId = postedCall!.streamId!;
		const item = () =>
			state.items.find(
				(it): it is Extract<ChatItem, { kind: "bash" }> => it.kind === "bash" && it.id === itemId,
			);
		return { call: postedCall!, itemId, item };
	}

	test("long-running bash streams past 30s and resolves when the late call_result arrives", async () => {
		const { call: bashCall, item } = startBang("!sleep 60", "bash");
		// timeout 0 = no timer armed for streamed commands.
		expect(timers).toEqual([]);
		expect(item()?.status).toBe("running");

		dispatch({ type: "bash_chunk", id: bashCall.streamId!, text: "tick\n" });
		dispatch({ type: "bash_chunk", id: bashCall.streamId!, text: "tock\n" });
		await flushMicrotasks();
		expect(item()?.status).toBe("running");
		expect(item()?.output).toBe("tick\ntock\n");

		// Well past the old 30s default: still running, output intact.
		advance(40_000);
		await flushMicrotasks();
		expect(item()?.status).toBe("running");
		expect(item()?.output).toBe("tick\ntock\n");

		// The server-side result is still correlated (not stranded) and is
		// authoritative — it carries the full streamed output.
		dispatch(callResult(bashCall.id, { output: "tick\ntock\nfull\n", exitCode: 0 }));
		await flushMicrotasks();
		expect(item()?.status).toBe("done");
		expect(item()?.exitCode).toBe(0);
		expect(item()?.output).toBe("tick\ntock\nfull\n");
	});

	test("long-running python streams past 30s and resolves when the late call_result arrives", async () => {
		const { call: pyCall, item } = startBang("$print('sleep')", "python");
		expect(timers).toEqual([]);

		dispatch({ type: "python_chunk", id: pyCall.streamId!, text: "one\n" });
		await flushMicrotasks();
		advance(40_000);
		await flushMicrotasks();
		expect(item()?.status).toBe("running");
		expect(item()?.output).toBe("one\n");

		dispatch(callResult(pyCall.id, { output: "one\ntwo\n", exitCode: 0 }));
		await flushMicrotasks();
		expect(item()?.status).toBe("done");
		expect(item()?.exitCode).toBe(0);
		expect(item()?.output).toBe("one\ntwo\n");
	});

	test("abort still cancels a >30s command and keeps the streamed output", async () => {
		const { call: bashCall, item } = startBang("!sleep 60", "bash");
		dispatch({ type: "bash_chunk", id: bashCall.streamId!, text: "tick\n" });
		await flushMicrotasks();
		advance(40_000);
		expect(item()?.status).toBe("running");

		// The UI's abort button posts abortBash as its own command.
		const abortPromise = call("abortBash");
		await flushMicrotasks();
		expect(posted.map((c) => (c.type === "call" ? c.method : c.type))).toEqual([
			"bash",
			"abortBash",
		]);
		const abortCall = posted.find(
			(c): c is Extract<ClientCommand, { type: "call" }> =>
				c.type === "call" && c.method === "abortBash",
		)!;

		// The server answers the ORIGINAL call with the cancelled result.
		dispatch(callResult(bashCall.id, { output: "tick\n", exitCode: 1, cancelled: true }));
		dispatch(callResult(abortCall.id, undefined));
		await abortPromise.catch(() => {});
		await flushMicrotasks();
		expect(item()?.status).toBe("done");
		expect(item()?.exitCode).toBe(1);
		expect(item()?.output).toBe("tick\n");
	});

	test("resolveBashItem appends an error marker instead of wiping streamed output", () => {
		setState({ items: [] });
		const streamed = addBashItem("!sleep 60", false);
		const empty = addBashItem("!never started", false);
		appendBashChunk(streamed, "partial output\n");
		const findBash = (id: number) =>
			state.items.find(
				(it): it is Extract<ChatItem, { kind: "bash" }> => it.kind === "bash" && it.id === id,
			);

		expect(findBash(streamed)?.output).toBe("partial output\n");
		resolveBashItem(streamed, { error: 'call "bash" timed out' });
		resolveBashItem(empty, { error: "Not connected" });

		expect(findBash(streamed)).toMatchObject({
			status: "done",
			exitCode: null,
			output: 'partial output\n[error] call "bash" timed out',
		});
		expect(findBash(empty)).toMatchObject({
			status: "done",
			exitCode: null,
			output: "[error] Not connected",
		});
	});
});

// ---------------------------------------------------------------------------
// P1 danger-model hardening: /new, /drop, and /fresh gate through the app's
// danger-confirm dialog (module-level state in ConfirmDialog.tsx) instead of
// window.confirm. Confirmation only when there is something to lose (non-empty
// transcript, or a turn streaming for /fresh); confirming runs the pending
// action and clears the dialog. The file-level beforeEach already resets
// items/connected and installs the fetch stub that records POSTed commands.
// ---------------------------------------------------------------------------
describe("danger confirm guards (P1 hardening)", () => {
	const connectTransport = () => {
		connect();
		const es = FakeEventSource.instances.at(-1);
		expect(es).toBeDefined();
		es!.onopen?.(); // connected = true; without this call() fails fast
	};

	const postedMethod = (method: string) =>
		posted.filter(
			(c): c is Extract<ClientCommand, { type: "call" }> =>
				c.type === "call" && c.method === method,
		);

	// Lightest transcript: one minimal user item.
	const seedItem = () => setState({ items: [{ kind: "user", id: 1, text: "hi" }] });

	beforeEach(() => {
		cancelDangerConfirm();
		setState({ items: [], streaming: false });
	});

	test("/new with a non-empty transcript requests a danger confirm and POSTs only after confirming", async () => {
		connectTransport();
		seedItem();
		dispatchInput("/new", undefined, "enter");
		await flushMicrotasks();
		expect(dangerConfirm()).toMatchObject({
			title: "Start a new session",
			confirmLabel: "New session",
		});
		expect(postedMethod("newSession")).toEqual([]);

		confirmDangerConfirm();
		await flushMicrotasks();
		expect(dangerConfirm()).toBeNull();
		expect(postedMethod("newSession").length).toBe(1);
	});

	test("/new with an empty transcript calls newSession immediately", async () => {
		connectTransport();
		dispatchInput("/new", undefined, "enter");
		await flushMicrotasks();
		expect(postedMethod("newSession").length).toBe(1);
		expect(dangerConfirm()).toBeNull();
	});

	test("/drop with a non-empty transcript requests a danger confirm and POSTs only after confirming", async () => {
		connectTransport();
		seedItem();
		dispatchInput("/drop", undefined, "enter");
		await flushMicrotasks();
		expect(dangerConfirm()).toMatchObject({
			title: "Drop this session",
			confirmLabel: "Drop session",
		});
		expect(postedMethod("newSession")).toEqual([]);

		confirmDangerConfirm();
		await flushMicrotasks();
		expect(dangerConfirm()).toBeNull();
		expect(postedMethod("newSession").length).toBe(1);
	});

	test("/fresh while streaming requests a danger confirm and POSTs only after confirming", async () => {
		connectTransport();
		setState("streaming", true);
		dispatchInput("/fresh", undefined, "enter");
		await flushMicrotasks();
		expect(dangerConfirm()).toMatchObject({
			title: "Reset provider state",
			confirmLabel: "Reset state",
		});
		expect(postedMethod("freshSession")).toEqual([]);

		confirmDangerConfirm();
		await flushMicrotasks();
		expect(dangerConfirm()).toBeNull();
		expect(postedMethod("freshSession").length).toBe(1);
	});

	test("/fresh while idle calls freshSession directly", async () => {
		connectTransport();
		dispatchInput("/fresh", undefined, "enter");
		await flushMicrotasks();
		expect(postedMethod("freshSession").length).toBe(1);
		expect(dangerConfirm()).toBeNull();
	});
});
