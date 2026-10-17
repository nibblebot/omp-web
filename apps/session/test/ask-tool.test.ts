/**
 * Regression guard for the daemon's terminal-global bootstrap: the web host
 * runs the pinned SDK in-process with a browser UI context and no TUI, so
 * nothing else initializes pi-tui's theme singleton. apps/session/sdk-tui-globals.ts
 * (called once at boot by index.ts) does, and the ask tool is the case that
 * regressed: AskTool.execute reads theme.status.success for its "Done selecting"
 * row before it opens any dialog (uninitialized: `undefined is not an object
 * (evaluating 'theme.status')`), and its waiting notification writes OSC bytes
 * to stdout, which this daemon reserves for OMP_SESSION| contract lines.
 *
 * The ask tool's dialog must reach whichever browser is attached. Production
 * browsers ride the callback pair as virtual streams (apps/session/daemon-control.ts
 * `browserStreamCount`, wired into ui-context by index.ts), which the daemon's
 * local `/events` consumer set never sees, so presence and delivery are covered
 * over a local stream, over the callback pair alone, and with nothing attached
 * (a reject, never a hang). This file runs the real pinned AskTool against the
 * daemon's browser UI context with a frame tap playing the browser: it answers
 * the askDialog ui_request exactly like index.ts's ui_response dispatch.
 *
 * initSdkTuiGlobals is idempotent and pi-tui's theme singleton has no reset, so
 * each test calls it in its own setup; only the process globals this file owns
 * (PI_NOTIFICATIONS, the frame tap, its own consumer) are restored, in afterAll.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { AskTool } from "@oh-my-pi/pi-coding-agent/tools/ask";
import { initSdkTuiGlobals } from "../sdk-tui-globals";
import {
	buildUiContext,
	cancelEntryUiRequests,
	pendingUiRequestFrames,
	setCallbackBrowserStreamCount,
} from "../ui-context";
import { setOnFrameTap, streams, type SseConsumer } from "../sse-delivery";
import type { SessionEntry } from "../session-entry";

// initSdkTuiGlobals sets PI_NOTIFICATIONS=off process-globally (the daemon's
// own boot call). `bun run test:isolated` runs every file in one process, so
// hand back the value this file found instead of leaking suppression into the
// files that run after it.
const originalNotifications = process.env.PI_NOTIFICATIONS;

// Settings.init is process-global and idempotent; in-memory settings touch no
// disk (same convention as daemon-broker.test.ts). The returned instance is the
// session's settings layer the tool call reads.
const settings = await Settings.init({ inMemory: true });

/** Only the SessionEntry fields buildUiContext reaches (handle/collab/pending map). */
const entry = {
	handle: "s1",
	collab: { adapter: null },
	pendingUiRequests: new Map(),
} as unknown as SessionEntry;

/** The local /events consumer stand-in: webUiRequest targets a stream attached to s1. */
const consumer = {
	id: 1,
	controller: { enqueue: () => {}, desiredSize: 1 } as never,
	attached: "s1",
	unreadEstimate: 0,
} as unknown as SseConsumer;

const originalStdoutWrite = process.stdout.write;

/** The askDialog ui_request params the tool puts on the wire (the card's contract). */
interface CapturedAskDialogParams {
	questions: Array<{ question: string; options: Array<{ label: string }> }>;
}

let capturedAskDialog: CapturedAskDialogParams | undefined;

/**
 * Play the browser: answer an askDialog ui_request the way index.ts's
 * ui_response dispatch does (drop the pending entry, resolve its promise) with
 * the selection the web ask card would submit. broadcastTo taps every frame
 * whether or not local streams are attached, the same seam index.ts uses to
 * mirror frames to the callback pair's browsers.
 */
const answerAskDialogAsBrowser: NonNullable<Parameters<typeof setOnFrameTap>[0]> = (frame) => {
	if (frame.type !== "ui_request" || frame.method !== "askDialog") return;
	capturedAskDialog = frame.params as CapturedAskDialogParams;
	const pending = entry.pendingUiRequests.get(frame.id);
	if (!pending) return;
	entry.pendingUiRequests.delete(frame.id);
	pending.resolve({
		kind: "submit",
		results: [{ id: "q1", selectedOptions: ["alpha"], timedOut: false }],
	});
};

/**
 * Run one test with exactly that test's browser presence installed: `localStream`
 * plays a /events consumer attached to s1 (this file's consumer, deleted first
 * so a previous test's leftovers never apply) and `callbackBrowsers` counts the
 * browsers riding the callback pair. Torn down before the test returns.
 */
async function withBrowserPresence(
	presence: { localStream: boolean; callbackBrowsers: number },
	run: () => Promise<void>,
): Promise<void> {
	capturedAskDialog = undefined;
	streams.delete(consumer);
	if (presence.localStream) {
		// An earlier test's detach nulls `attached`; re-bind it to this file's session.
		consumer.attached = "s1";
		streams.add(consumer);
	}
	setCallbackBrowserStreamCount(() => presence.callbackBrowsers);
	setOnFrameTap(answerAskDialogAsBrowser);
	try {
		await run();
	} finally {
		streams.delete(consumer);
		setOnFrameTap(null);
		setCallbackBrowserStreamCount(null);
	}
}

/**
 * Run the real pinned AskTool over the shipped browser UI context with stdout
 * captured: the tool writes OSC/BEL notification bytes there while it waits,
 * and this daemon reserves stdout for OMP_SESSION| contract lines.
 */
async function runAskTool(): Promise<{ texts: string[]; stdoutChunks: string[] }> {
	// The daemon's boot call (index.ts): theme singleton + suppressed
	// terminal notifications. Without it the tool call below throws with
	// `undefined is not an object (evaluating 'theme.status')`.
	initSdkTuiGlobals();

	const session = {
		cwd: process.cwd(),
		hasUI: true,
		settings,
		getPlanModeState: () => undefined,
	} as unknown as ConstructorParameters<typeof AskTool>[0];
	const tool = new AskTool(session);
	const ui = buildUiContext(entry);

	const stdoutChunks: string[] = [];
	process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
		stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return (originalStdoutWrite as unknown as (...args: unknown[]) => boolean).apply(
			process.stdout,
			[chunk, ...rest],
		);
	}) as unknown as typeof process.stdout.write;
	try {
		const result = await tool.execute(
			"call-1",
			{
				questions: [
					{
						id: "q1",
						question: "Pick one?",
						options: [{ label: "alpha" }, { label: "beta" }],
					},
				],
			},
			undefined,
			undefined,
			{ hasUI: true, abort: () => {}, ui } as unknown as Parameters<AskTool["execute"]>[4],
		);
		return {
			texts: result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
			stdoutChunks,
		};
	} finally {
		process.stdout.write = originalStdoutWrite;
	}
}

afterAll(() => {
	streams.delete(consumer);
	setOnFrameTap(null);
	setCallbackBrowserStreamCount(null);
	process.stdout.write = originalStdoutWrite;
	if (originalNotifications === undefined) delete process.env.PI_NOTIFICATIONS;
	else process.env.PI_NOTIFICATIONS = originalNotifications;
});

describe("ask tool over the daemon's browser UI context", () => {
	test("runs the pinned ask tool over the browser UI context", async () => {
		await withBrowserPresence({ localStream: true, callbackBrowsers: 0 }, async () => {
			const { texts, stdoutChunks } = await runAskTool();

			// The browser contract: the ask card renders this question and these labels.
			expect(capturedAskDialog).toBeDefined();
			const question = capturedAskDialog!.questions[0];
			expect(question.question).toBe("Pick one?");
			expect(question.options.map((option) => option.label)).toEqual(["alpha", "beta"]);

			// The daemon-shaped answer reached the real tool.
			expect(texts).toContain("User selected: alpha");
			expect(entry.pendingUiRequests.size).toBe(0);

			// Terminal notifications must never land on this daemon's stdout
			// (OMP_SESSION| contract lines only): PI_NOTIFICATIONS=off is set by
			// initSdkTuiGlobals, exactly like the SDK's own RPC mode does. Cheap
			// guard: bun may already suppress notifications under test.
			expect(stdoutChunks.filter((chunk) => chunk.includes("\x1b"))).toEqual([]);
		});
	});

	test("a browser attached through the callback pair answers without a local stream", async () => {
		// Production: the fleet dials the daemon, so no /events consumer is
		// attached and the browser exists only as a pair-side virtual stream.
		await withBrowserPresence({ localStream: false, callbackBrowsers: 1 }, async () => {
			const { texts } = await runAskTool();

			// The frame rode the mirror tap to the browser and the browser
			// answered: the card's params plus the tool's selection row.
			expect(capturedAskDialog).toBeDefined();
			const question = capturedAskDialog!.questions[0];
			expect(question.question).toBe("Pick one?");
			expect(question.options.map((option) => option.label)).toEqual(["alpha", "beta"]);
			expect(texts).toContain("User selected: alpha");
			expect(entry.pendingUiRequests.size).toBe(0);
		});
	});

	test("no attached browser rejects instead of hanging", async () => {
		await withBrowserPresence({ localStream: false, callbackBrowsers: 0 }, async () => {
			await expect(runAskTool()).rejects.toThrow("No connected client to answer the UI request");
			expect(entry.pendingUiRequests.size).toBe(0);
		});
	});

	test("Stop cancels a pending ask: the dialog ends and the turn does not hang", async () => {
		await withBrowserPresence({ localStream: true, callbackBrowsers: 0 }, async () => {
			const opened: string[] = [];
			const ended: string[] = [];
			setOnFrameTap((frame) => {
				if (frame.type === "ui_request" && frame.method === "askDialog") {
					opened.push(frame.id);
					// Stop lands while the browser is still deciding; defer past the broadcast.
					queueMicrotask(() => cancelEntryUiRequests(entry));
				}
				if (frame.type === "ui_request_end") ended.push(frame.id);
			});
			await expect(runAskTool()).rejects.toThrow(/cancel/i);
			expect(opened).toHaveLength(1);
			expect(ended).toEqual(opened);
			expect(entry.pendingUiRequests.size).toBe(0);
		});
	});

	test("priming replays an open ask to a late client but never browser_ui requests", () => {
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		promise.catch(() => {});
		entry.pendingUiRequests.set("ui900", {
			streams: new Set<SseConsumer>(),
			method: "askDialog",
			params: { questions: [] },
			resolve,
			reject,
		});
		entry.pendingUiRequests.set("ui901", {
			streams: new Set<SseConsumer>(),
			method: "browser_ui",
			params: {},
			resolve,
			reject,
		});
		try {
			expect(pendingUiRequestFrames(entry)).toEqual([
				{ type: "ui_request", id: "ui900", method: "askDialog", params: { questions: [] } },
			]);
		} finally {
			entry.pendingUiRequests.clear();
		}
	});
});
