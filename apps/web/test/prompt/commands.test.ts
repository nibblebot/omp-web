import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	compactDispatch,
	dispatchInput,
	dumpDispatch,
	exportDispatch,
	exportRouteArgs,
	handoffArgs,
	LOCAL_COMMANDS,
	modelDispatch,
	parseInput,
	planDispatch,
	queueMethod,
	renameDispatch,
	resumeDispatch,
} from "../../prompt/commands";
import { SSE_EVENT_NAME } from "#lib/wire/protocol";
import type { ClientCommand, ServerFrame } from "#lib/wire/protocol";
import {
	addBashItem,
	appendBashChunk,
	call,
	connect,
	resolveBashItem,
	setState,
	state,
	type ChatItem,
} from "../../state";
import {
	cancelDangerConfirm,
	confirmDangerConfirm,
	dangerConfirm,
} from "../../prompt/danger-confirm";
import { restoreBrowserGlobals, setBrowserGlobal } from "../web.testkit";
import { FEATURE_IDS, type FeatureId } from "../../features/manifest";
import { activateFeatures, isFeatureEnabled } from "../../features/registry";

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

	test("/help and /hotkeys open the Help modal on their own tabs", () => {
		setState("modal", null);
		LOCAL_COMMANDS.help?.("");
		expect(state.modal).toBe("help");
		LOCAL_COMMANDS.hotkeys?.("");
		expect(state.modal).toBe("hotkeys");
		setState("modal", null);
	});

	test("covers the Phase 8 session-command set", () => {
		for (const name of ["retry", "fork", "fresh", "handoff", "delete", "dump", "rename"]) {
			expect(LOCAL_COMMANDS[name]).toBeFunction();
		}
		expect(LOCAL_COMMANDS["drop"]).toBeUndefined();
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
	test("LOCAL_COMMANDS covers plan", () => {
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

	test("/plan toggles planModeEnabled via setPlanModeState", () => {
		const before = state.planModeEnabled;
		try {
			setState("planModeEnabled", false);
			expect(planDispatch().args[0].enabled).toBe(true);
			expect(planDispatch().args[0]).toEqual({ enabled: true });
			// Flip the store and confirm the toggle inverts.
			setState("planModeEnabled", true);
			expect(planDispatch().args[0].enabled).toBe(false);
		} finally {
			setState("planModeEnabled", before);
		}
	});
});

describe("Phase 11 web-plus commands", () => {
	test("LOCAL_COMMANDS covers the Phase 11 set", () => {
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

	test("/export parses a path that exportRoute refuses (downloads save via the browser)", () => {
		expect(exportRouteArgs("--themes")).toEqual({ useThemes: true });
		expect(exportRouteArgs("--themes /tmp/out.html")).toEqual({
			useThemes: true,
			path: "/tmp/out.html",
		});
		expect(exportRouteArgs("")).toEqual({ useThemes: false });
	});
});

describe("P0.2 argument-aware collision routes", () => {
	test("/resume bare opens picker, id arg switches", () => {
		expect(resumeDispatch("")).toEqual({ kind: "picker" });
		expect(resumeDispatch("   ")).toEqual({ kind: "picker" });
		expect(resumeDispatch("abc123")).toEqual({ kind: "switch", target: "abc123" });
		expect(resumeDispatch("@claude")).toEqual({ kind: "switch", target: "@claude" });
	});

	test("/model bare opens settings Model tab, selector selects", () => {
		expect(modelDispatch("")).toEqual({ kind: "settings" });
		expect(modelDispatch("anthropic/claude-opus")).toEqual({
			kind: "select",
			selector: "anthropic/claude-opus",
		});
	});

	test("/compact mirrors parseCompactArgs verdicts", () => {
		expect(compactDispatch("")).toEqual({ kind: "run" });
		expect(compactDispatch("soft")).toEqual({ kind: "run", mode: "soft", instructions: undefined });
		expect(compactDispatch("remote focus on api")).toEqual({
			kind: "run",
			mode: "remote",
			instructions: "focus on api",
		});
		expect(compactDispatch("focus on api")).toEqual({ kind: "run", instructions: "focus on api" });
		expect(compactDispatch("snapcompact extra").kind).toBe("usage");
		expect(compactDispatch("SOFT focus")).toEqual({
			kind: "run",
			mode: "soft",
			instructions: "focus",
		});
	});

	test("/dump bare/all/request/unknown", () => {
		expect(dumpDispatch("")).toEqual({ kind: "single" });
		expect(dumpDispatch("all")).toEqual({ kind: "all" });
		expect(dumpDispatch("ALL")).toEqual({ kind: "all" });
		expect(dumpDispatch("request")).toEqual({ kind: "request" });
		expect(dumpDispatch("everything").kind).toBe("usage");
	});

	test("/plan with prompt enters plan mode, bare toggles", () => {
		const before = state.planModeEnabled;
		try {
			setState("planModeEnabled", false);
			expect(planDispatch("design the api").args[0].enabled).toBe(true);
			expect(planDispatch("").args[0].enabled).toBe(true);
			expect(planDispatch().args[0].enabled).toBe(true);
		} finally {
			setState("planModeEnabled", before);
		}
	});

	test("LOCAL_COMMANDS covers move/wt/worktree refusals", () => {
		expect(LOCAL_COMMANDS.move).toBeFunction();
		expect(LOCAL_COMMANDS.wt).toBeFunction();
		expect(LOCAL_COMMANDS.worktree).toBeFunction();
		expect(LOCAL_COMMANDS.resume).toBeFunction();
		expect(LOCAL_COMMANDS.model).toBeFunction();
		expect(LOCAL_COMMANDS.dump).toBeFunction();
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
	setBrowserGlobal("window", {
		setTimeout: (fn: () => void, ms?: number) => {
			timers.push({ fn, ms: ms ?? 0, fired: false });
			return timers.length;
		},
		clearTimeout: () => {},
	} as unknown as Window & typeof globalThis);
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
	setBrowserGlobal("location", { search: "" } as Location);
	setBrowserGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
	setBrowserGlobal("fetch", (async (_input: unknown, init?: RequestInit) => {
		if (typeof init?.body === "string") posted.push(JSON.parse(init.body) as ClientCommand);
		return { ok: true, status: 202 } as Response;
	}) as unknown as typeof fetch);
	setState({
		currentSessionId: "",
		connected: false,
		readyAt: undefined,
		subagents: new Map(),
		items: [],
	});
});

// Browser doubles are process-global; restore them after each test so they
// cannot leak into sibling test files run in the same worker.
afterEach(restoreBrowserGlobals);

describe("bang-shell/python stream lifecycle (#29)", () => {
	test("/live is refused locally without sending a prompt", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		const before = state.items.length;
		dispatchInput("/live", undefined, "enter");
		expect(posted.filter((command) => command.type === "call")).toEqual([]);
		expect(state.items.slice(before)).toMatchObject([
			{
				kind: "notice",
				level: "error",
				message: "/live is terminal-only: realtime voice runs in the omp terminal UI.",
			},
		]);
	});

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
		// Streamed commands have no deadline, but transport recovery still
		// replays the same id while the daemon's dedup record is valid.
		expect(timers.map((timer) => timer.ms)).toEqual([5_000]);
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
		// authoritative, since it carries the full streamed output.
		dispatch(callResult(bashCall.id, { output: "tick\ntock\nfull\n", exitCode: 0 }));
		await flushMicrotasks();
		expect(item()?.status).toBe("done");
		expect(item()?.exitCode).toBe(0);
		expect(item()?.output).toBe("tick\ntock\nfull\n");
	});

	test("long-running python streams past 30s and resolves when the late call_result arrives", async () => {
		const { call: pyCall, item } = startBang("$print('sleep')", "python");
		expect(timers.map((timer) => timer.ms)).toEqual([5_000]);

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

		// The UI's abort button posts abortBash as its own command. The
		// unanswered bash call was replayed once with the same dedup id.
		const abortPromise = call("abortBash");
		await flushMicrotasks();
		expect(posted.map((c) => (c.type === "call" ? c.method : c.type))).toEqual([
			"bash",
			"bash",
			"abortBash",
		]);
		expect(posted[1]).toEqual(posted[0]);
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

	test("resolveBashItem appends an error marker instead of wiping streamed output", async () => {
		setState({ items: [] });
		const streamed = addBashItem("!sleep 60", false);
		const empty = addBashItem("!never started", false);
		appendBashChunk(streamed, "partial output\n");
		// Chunks land on the rAF flush (a microtask in the test env), so drain
		// the microtask queue before asserting the streamed text.
		await flushMicrotasks();
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
// P1 danger-model hardening: /fresh gates through the app's
// danger-confirm dialog (module-level state in ConfirmDialog.tsx) instead of
// window.confirm. Confirmation only when there is something to lose
// (a turn streaming); confirming runs the pending
// action and clears the dialog. `/new` executes immediately with no
// confirmation. The file-level beforeEach already resets
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

	test("/new with a non-empty transcript calls newSession immediately with no danger confirm", async () => {
		connectTransport();
		seedItem();
		dispatchInput("/new", undefined, "enter");
		await flushMicrotasks();
		expect(postedMethod("newSession").length).toBe(1);
		expect(dangerConfirm()).toBeNull();
	});

	test("/new with an empty transcript calls newSession immediately", async () => {
		connectTransport();
		dispatchInput("/new", undefined, "enter");
		await flushMicrotasks();
		expect(postedMethod("newSession").length).toBe(1);
		expect(dangerConfirm()).toBeNull();
	});

	test("/delete requests a danger confirm and POSTs deleteSession only after confirming", async () => {
		connectTransport();
		seedItem();
		dispatchInput("/delete", undefined, "enter");
		await flushMicrotasks();
		expect(dangerConfirm()).toMatchObject({
			title: "Delete this session?",
			confirmLabel: "Delete session",
		});
		expect(postedMethod("deleteSession")).toEqual([]);

		confirmDangerConfirm();
		await flushMicrotasks();
		expect(dangerConfirm()).toBeNull();
		expect(postedMethod("deleteSession").length).toBe(1);
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

describe("disabled feature commands", () => {
	beforeEach(() => {
		setState({ items: [], streaming: false });
	});

	test("a slash command owned by a disabled feature shows a local notice and is never forwarded", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		posted.length = 0;
		dispatchInput("/git", undefined, "enter");
		expect(state.items.at(-1)).toMatchObject({
			kind: "notice",
			message: "/git is part of Review, which is disabled. Enable it in Settings > Features.",
		});
		expect(posted.some((c) => c.type === "call" && c.method === "prompt")).toBe(false);
	});
});

describe("feature-owned commands with arguments (INT-06)", () => {
	let baselineFeatures: FeatureId[] = [];
	beforeAll(() => {
		baselineFeatures = FEATURE_IDS.filter(isFeatureEnabled);
	});
	afterAll(async () => {
		await activateFeatures(baselineFeatures);
	});
	beforeEach(async () => {
		setState({ items: [], streaming: false });
		await activateFeatures(["integrations"]);
	});

	test("/skills with a subcommand shows a terminal-only notice and is never forwarded", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		posted.length = 0;
		dispatchInput("/skills status", undefined, "enter");
		expect(state.items.at(-1)).toMatchObject({
			kind: "notice",
			message:
				'/skills status is terminal-only. Install or update skills with "omp skill status" in a terminal; turn skills on or off in the Integrations sheet.',
		});
		expect(posted.some((c) => c.type === "call" && c.method === "prompt")).toBe(false);
	});
});

describe("command dispatch routing (CMD-07, CMD-09, COL-09, INT-06)", () => {
	beforeEach(() => {
		setState({ items: [], streaming: false });
	});

	function promptCalls() {
		return posted.filter((c) => c.type === "call" && c.method === "prompt");
	}

	test("an unknown command is never sent to the model and says so", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		posted.length = 0;
		dispatchInput("/zzqx", undefined, "enter");
		expect(promptCalls()).toEqual([]);
		expect(state.items.at(-1)).toMatchObject({
			kind: "notice",
			level: "info",
			message: "Unknown command /zzqx. Type /help to list commands.",
		});
	});

	test("a terminal-only command is not forwarded and gets a notice", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		posted.length = 0;
		dispatchInput("/collab status", undefined, "enter");
		expect(promptCalls()).toEqual([]);
		expect(state.items.at(-1)).toMatchObject({
			kind: "notice",
			level: "info",
			message: expect.stringContaining(
				"/collab is terminal-only and is not available in the browser.",
			),
		});
	});

	test("/stats is not forwarded and points at /usage", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		posted.length = 0;
		dispatchInput("/stats", undefined, "enter");
		expect(promptCalls()).toEqual([]);
		expect(state.items.at(-1)).toMatchObject({
			kind: "notice",
			message: expect.stringContaining("Use /usage"),
		});
	});

	test("a forwarded command echoes itself as a notice before it is sent", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		posted.length = 0;
		dispatchInput("/security status", undefined, "enter");
		expect(promptCalls().length).toBe(1);
		expect(state.items.at(-1)).toMatchObject({
			kind: "notice",
			level: "echo",
			message: "/security status",
		});
	});

	test("/skills with arguments is never forwarded to the model", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		posted.length = 0;
		dispatchInput("/skills status", undefined, "enter");
		expect(promptCalls()).toEqual([]);
		expect(state.items.at(-1)).toMatchObject({
			kind: "notice",
			level: "info",
			message:
				"/skills is part of MCP & Skills, which is disabled. Enable it in Settings > Features.",
		});
	});

	test("/settings with a query opens the Settings sheet with the search pre-filled", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		posted.length = 0;
		dispatchInput("/settings  security ", undefined, "enter");
		expect(state.modal).toBe("settings");
		expect(state.settingsQuery).toBe("security");
		expect(promptCalls()).toEqual([]);
	});

	test("a bare /settings clears a stale search query", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		setState({ settingsQuery: "stale" });
		dispatchInput("/settings", undefined, "enter");
		expect(state.modal).toBe("settings");
		expect(state.settingsQuery).toBe("");
	});

	test("a queueable builtin (/add-dir) queues instead of echoing while a turn streams (U10b)", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		setState("streaming", true);
		posted.length = 0;
		dispatchInput("/add-dir /tmp/extra", undefined, "enter");
		expect(promptCalls()).toEqual([]);
		expect(posted).toContainEqual(
			expect.objectContaining({
				type: "call",
				method: "queueCommand",
				args: ["/add-dir /tmp/extra"],
			}),
		);
		expect(state.items.filter((i) => i.kind === "notice")).toEqual([]);
	});

	test("a queued builtin keeps its attached images on the queueCommand call", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		setState("streaming", true);
		posted.length = 0;
		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		dispatchInput("/add-dir /tmp/extra", [image], "enter");
		expect(posted).toContainEqual(
			expect.objectContaining({
				type: "call",
				method: "queueCommand",
				args: ["/add-dir /tmp/extra", [image]],
			}),
		);
	});

	test("an idle /add-dir runs at once through prompt and is not queued (U10b)", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		posted.length = 0;
		dispatchInput("/add-dir /tmp/extra", undefined, "enter");
		expect(promptCalls().length).toBe(1);
		expect(posted.some((c) => c.type === "call" && c.method === "queueCommand")).toBe(false);
	});

	test("a read-only forwarded command still runs through prompt while streaming (jx0b)", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		setState("streaming", true);
		posted.length = 0;
		dispatchInput("/dirs", undefined, "enter");
		expect(promptCalls().length).toBe(1);
		expect(posted.some((c) => c.type === "call" && c.method === "queueCommand")).toBe(false);
	});
});

describe("busy policy dispatch (CMD-08, jx0b)", () => {
	beforeEach(() => {
		setState({
			items: [],
			streaming: false,
			availableCommands: [
				{ name: "skill:lint", source: "skill" },
				{ name: "fix-bug", source: "file" },
				{ name: "ext-status", source: "extension" },
			],
		});
	});

	function promptCalls() {
		return posted.filter((c) => c.type === "call" && c.method === "prompt");
	}

	test.each(["/skill:lint", "/fix-bug", "/ext-status", "/security status"])(
		"%s queues instead of running while a turn streams (jx0b)",
		(text) => {
			connect();
			FakeEventSource.instances.at(-1)!.onopen?.();
			setState("streaming", true);
			posted.length = 0;
			dispatchInput(text, undefined, "enter");
			expect(promptCalls()).toEqual([]);
			expect(posted).toContainEqual(
				expect.objectContaining({ type: "call", method: "queueCommand", args: [text] }),
			);
		},
	);

	test("/session delete is refused while a turn streams: no queue, no SDK call (jx0b)", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		setState("streaming", true);
		posted.length = 0;
		dispatchInput("/session delete", undefined, "enter");
		expect(promptCalls()).toEqual([]);
		expect(posted.some((c) => c.type === "call" && c.method === "queueCommand")).toBe(false);
		expect(state.items.at(-1)).toMatchObject({
			kind: "notice",
			level: "info",
			message: expect.stringContaining("Stop the turn"),
		});
	});

	test("/delete is refused while a turn streams: no confirm dialog, no deleteSession (jx0b)", () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		setState("streaming", true);
		posted.length = 0;
		dispatchInput("/delete", undefined, "enter");
		expect(dangerConfirm()).toBeNull();
		expect(posted.some((c) => c.type === "call" && c.method === "deleteSession")).toBe(false);
		expect(state.items.at(-1)).toMatchObject({
			kind: "notice",
			level: "info",
			message: expect.stringContaining("Stop the turn"),
		});
	});
});
