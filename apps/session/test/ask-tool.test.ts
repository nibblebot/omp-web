/**
 * Regression guard for the session's terminal-global bootstrap: the web host
 * runs the pinned SDK in-process with a browser UI context and no TUI, so
 * nothing else initializes pi-tui's theme singleton. apps/session/sdk-tui-globals.ts
 * (called once at boot by index.ts) does, and the ask tool is the case that
 * regressed: AskTool.execute reads theme.status.success for its "Done selecting"
 * row before it opens any dialog (uninitialized: `undefined is not an object
 * (evaluating 'theme.status')`), and its waiting notification writes OSC bytes
 * to stdout, which this session reserves for OMP_SESSION| contract lines.
 *
 * The ask tool's dialog must reach whichever browser is attached. Production
 * browsers ride the callback pair as virtual streams (apps/session/session-control.ts
 * `browserStreamCount`, wired into ui-context by index.ts), which the session's
 * local `/ws` consumer set never sees, so presence and delivery are covered
 * over a local stream, over the callback pair alone, and with nothing attached
 * (a reject, never a hang). This file runs the real pinned AskTool against the
 * session's browser UI context with a frame tap playing the browser: it answers
 * the `formDialog` ui_request exactly like index.ts's ui_response dispatch.
 *
 * The same tool call then covers the form dialog's contract: the structured form on the
 * wire, the SDK's answer text and details, notes on chosen options, cancel, the timeout
 * submitting the defaults, an invalid answer, Stop, priming a late client, and a collab
 * guest walking the form.
 *
 * initSdkTuiGlobals is idempotent and pi-tui's theme singleton has no reset, so
 * each test calls it in its own setup; only the process globals this file owns
 * (PI_NOTIFICATIONS, the frame tap, its own consumer) are restored, in afterAll.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { AskTool } from "@oh-my-pi/pi-coding-agent/tools/ask";
import { defaultFormData, formAnswers } from "@oh-my-pi/pi-tui/html-form/data";
import { parseHtmlForm } from "@oh-my-pi/pi-tui/html-form/parse";
import type { AskToolDetails } from "@oh-my-pi/pi-tui/tools/ask";
import { formFields, type UiFormParams } from "#lib/wire/ask-form";
import { initSdkTuiGlobals } from "../sdk-tui-globals";
import {
	buildUiContext,
	cancelEntryUiRequests,
	pendingUiRequestFrames,
	setCallbackBrowserStreamCount,
} from "../ui-context";
import { setOnFrameTap, streams, type ClientConsumer } from "../client-delivery";
import type { CollabUiRequestDraft } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import type { CollabHostAdapter } from "../collab-host";
import type { SessionEntry } from "../session-entry";

// initSdkTuiGlobals sets PI_NOTIFICATIONS=off process-globally (the session's
// own boot call). `bun run test:isolated` runs every file in one process, so
// hand back the value this file found instead of leaking suppression into the
// files that run after it.
const originalNotifications = process.env.PI_NOTIFICATIONS;

// Settings.init is process-global and idempotent; in-memory settings touch no
// disk (same convention as daemon-broker.test.ts). The returned instance is the
// session's settings layer the tool call reads.
const settings = await Settings.init({ inMemory: true });

/** Only the SessionEntry fields buildUiContext reaches (handle/cwd/collab/pending map). */
const entry = {
	handle: "s1",
	cwd: process.cwd(),
	collab: { adapter: null as CollabHostAdapter | null },
	pendingUiRequests: new Map(),
} as unknown as SessionEntry;

/** The local /ws consumer stand-in: webUiRequest targets a socket attached to s1. */
const consumer = {
	id: 1,
	ws: { readyState: 1, getBufferedAmount: () => 0, send: () => 1, close: () => {} } as never,
	attached: "s1",
	lastSendAt: 0,
} as ClientConsumer;

const originalStdoutWrite = process.stdout.write;

/** Field indices: store 0, checks 1, days 2, notes 3. */
const ASK_FORM_HTML = `<form>
  <input type="hidden" name="source" value="ui">
  <p>Pick a store?</p>
  <label><input type="radio" name="store" value="sqlite" checked> SQLite</label>
  <label><input type="radio" name="store" value="redis"> Redis</label>
  <fieldset>
    <legend>Checks</legend>
    <label><input type="checkbox" name="checks" value="types" checked> types</label>
    <label><input type="checkbox" name="checks" value="lint"> lint</label>
    <label><input type="checkbox" name="checks" value="test"> test</label>
  </fieldset>
  <label>Days <input type="number" name="days" value="30" min="1" max="90"></label>
  <label>Notes <textarea name="notes" rows="3">hello</textarea></label>
</form>`;

const form = parseHtmlForm(ASK_FORM_HTML);

/** The browser submitting the form with these answers (a Redis pick and a longer lifetime). */
const SUBMIT_REDIS = {
	kind: "submit",
	answers: [
		{ kind: "choice", index: 0, checked: [1] },
		{ kind: "choice", index: 1, checked: [0, 2] },
		{ kind: "text", index: 2, text: "45" },
		{ kind: "text", index: 3, text: "see you" },
	],
};

/** What the SDK reports for SUBMIT_REDIS. */
const REDIS_DATA = {
	source: "ui",
	store: "redis",
	checks: ["types", "test"],
	days: 45,
	notes: "see you",
};

/** The ui_request params the tool puts on the wire for the form (the AskBar's contract). */
let capturedForm: UiFormParams | undefined;
/** Every dialog method the browser was asked, in order. */
let methodsSeen: string[] = [];
/** Settles when the browser sees the `formDialog` request: the dialog opens after its pictures load. */
let presented = Promise.withResolvers<void>();

/** Leave a `formDialog` unanswered: the browser is still deciding. */
const HOLD = Symbol("hold");
type Responder = (params: UiFormParams) => unknown;
let respond: Responder = () => SUBMIT_REDIS;

/**
 * Play the browser: answer a `formDialog` ui_request the way index.ts's
 * ui_response dispatch does (drop the pending entry, resolve its promise with
 * the raw answer the web form would submit; `undefined` is a cancel). broadcastTo
 * taps every frame whether or not local streams are attached, the same seam
 * index.ts uses to mirror frames to the callback pair's browsers.
 */
const answerFormAsBrowser: NonNullable<Parameters<typeof setOnFrameTap>[0]> = (frame) => {
	if (frame.type !== "ui_request") return;
	methodsSeen.push(frame.method);
	if (frame.method !== "formDialog") return;
	capturedForm = frame.params as UiFormParams;
	presented.resolve();
	const answer = respond(capturedForm);
	if (answer === HOLD) return;
	const pending = entry.pendingUiRequests.get(frame.id);
	if (!pending) return;
	entry.pendingUiRequests.delete(frame.id);
	pending.resolve(answer);
};

/**
 * Run one test with exactly that test's browser presence installed: `localStream`
 * plays a /ws consumer attached to s1 (this file's consumer, deleted first
 * so a previous test's leftovers never apply) and `callbackBrowsers` counts the
 * browsers riding the callback pair. Torn down before the test returns.
 */
async function withBrowserPresence(
	presence: { localStream: boolean; callbackBrowsers: number },
	run: () => Promise<void>,
): Promise<void> {
	capturedForm = undefined;
	presented = Promise.withResolvers<void>();
	methodsSeen = [];
	respond = () => SUBMIT_REDIS;
	streams.delete(consumer);
	if (presence.localStream) {
		// An earlier test's detach nulls `attached`; re-bind it to this file's session.
		consumer.attached = "s1";
		streams.add(consumer);
	}
	setCallbackBrowserStreamCount(() => presence.callbackBrowsers);
	setOnFrameTap(answerFormAsBrowser);
	try {
		await run();
	} finally {
		streams.delete(consumer);
		setOnFrameTap(null);
		setCallbackBrowserStreamCount(null);
		entry.collab.adapter = null;
	}
}

interface AskRun {
	texts: string[];
	details: AskToolDetails | undefined;
	stdoutChunks: string[];
}

/**
 * Run the real pinned AskTool over the shipped browser UI context with stdout
 * captured: the tool writes OSC/BEL notification bytes there while it waits,
 * and this session reserves stdout for OMP_SESSION| contract lines.
 */
async function runAskTool(
	toolSettings: Settings = settings,
	html = ASK_FORM_HTML,
): Promise<AskRun> {
	// The session's boot call (index.ts): theme singleton + suppressed
	// terminal notifications. Without it the tool call below throws with
	// `undefined is not an object (evaluating 'theme.status')`.
	initSdkTuiGlobals();

	const session = {
		cwd: process.cwd(),
		hasUI: true,
		settings: toolSettings,
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
		const result = await tool.execute("call-1", { html }, undefined, undefined, {
			hasUI: true,
			abort: () => {},
			ui,
		} as unknown as Parameters<AskTool["execute"]>[4]);
		return {
			texts: result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
			details: result.details,
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

describe("ask tool over the session's browser UI context", () => {
	test("runs the pinned ask tool over the browser UI context", async () => {
		await withBrowserPresence({ localStream: true, callbackBrowsers: 0 }, async () => {
			const { texts, details, stdoutChunks } = await runAskTool();

			// The browser contract: the form rides one formDialog request, never a field-by-field walk.
			expect(methodsSeen).toEqual(["formDialog"]);
			expect(capturedForm).toBeDefined();
			const fields = formFields(capturedForm!);
			expect(fields.map((f) => [f.index, f.name, f.question])).toEqual([
				[0, "store", "Pick a store?"],
				[1, "checks", "Checks"],
				[2, "days", "Days"],
				[3, "notes", "Notes"],
			]);
			expect(capturedForm!.hidden).toEqual([["source", "ui"]]);
			expect(capturedForm!.sections.map((s) => s.title.map((span) => span.text).join(""))).toEqual([
				"",
				"Checks",
				"",
			]);
			// No timeout setting: no deadline on the wire.
			expect(capturedForm!.deadline).toBeUndefined();

			// The SDK's text and details for the submitted form data.
			expect(texts).toEqual([`User answers:\n${JSON.stringify(REDIS_DATA, null, 2)}`]);
			expect(details).toEqual({ answers: formAnswers(form, REDIS_DATA) });
			expect(details?.answers.find((a) => a.name === "store")).toMatchObject({
				question: "Pick a store?",
				answer: "Redis",
			});
			expect(entry.pendingUiRequests.size).toBe(0);

			// Terminal notifications must never land on this session's stdout
			// (OMP_SESSION| contract lines only): PI_NOTIFICATIONS=off is set by
			// initSdkTuiGlobals, exactly like the SDK's own RPC mode does. Cheap
			// guard: bun may already suppress notifications under test.
			expect(stdoutChunks.filter((chunk) => chunk.includes("\x1b"))).toEqual([]);
		});
	});

	test("a browser attached through the callback pair answers without a local stream", async () => {
		// Production: the fleet dials the session, so no /ws consumer is
		// attached and the browser exists only as a pair-side virtual stream.
		await withBrowserPresence({ localStream: false, callbackBrowsers: 1 }, async () => {
			const { texts } = await runAskTool();

			// The frame rode the mirror tap to the browser and the browser
			// answered: the form's params plus the tool's answer JSON.
			expect(capturedForm).toBeDefined();
			expect(formFields(capturedForm!)).toHaveLength(4);
			expect(texts).toEqual([`User answers:\n${JSON.stringify(REDIS_DATA, null, 2)}`]);
			expect(entry.pendingUiRequests.size).toBe(0);
		});
	});

	test("no attached browser rejects instead of hanging", async () => {
		await withBrowserPresence({ localStream: false, callbackBrowsers: 0 }, async () => {
			await expect(runAskTool()).rejects.toThrow("No connected client to answer the UI request");
			expect(entry.pendingUiRequests.size).toBe(0);
		});
	});

	test("a cancel from the browser cancels the ask", async () => {
		await withBrowserPresence({ localStream: true, callbackBrowsers: 0 }, async () => {
			respond = () => undefined;
			await expect(runAskTool()).rejects.toThrow(/cancelled by the user/);
			expect(entry.pendingUiRequests.size).toBe(0);
		});
	});

	test("an answer the form's rules reject fails the tool call instead of submitting bad data", async () => {
		await withBrowserPresence({ localStream: true, callbackBrowsers: 0 }, async () => {
			respond = () => ({ kind: "submit", answers: [{ kind: "text", index: 2, text: "500" }] });
			await expect(runAskTool()).rejects.toThrow(/Days.*at most 90/);
			expect(entry.pendingUiRequests.size).toBe(0);
		});
	});

	test("the ask timeout submits the form's defaults as timedOut and ends the web dialog", async () => {
		await withBrowserPresence({ localStream: true, callbackBrowsers: 0 }, async () => {
			respond = () => HOLD;
			const ended: string[] = [];
			const opened: string[] = [];
			setOnFrameTap((frame) => {
				if (frame.type === "ui_request") opened.push(frame.id);
				if (frame.type === "ui_request_end") ended.push(frame.id);
				answerFormAsBrowser(frame);
			});
			const before = Date.now();
			const { texts, details } = await runAskTool(Settings.isolated({ "ask.timeout": 1 }));

			const defaults = defaultFormData(form);
			expect(texts).toEqual([
				`No answer before the timeout; submitted the form's current values:\n${JSON.stringify(defaults, null, 2)}`,
			]);
			expect(details).toEqual({ answers: formAnswers(form, defaults), timedOut: true });
			// The deadline rode the wire (a fixed one second from presentation) and the dialog ended.
			expect(capturedForm!.deadline).toBeGreaterThanOrEqual(before + 1000);
			expect(capturedForm!.deadline).toBeLessThanOrEqual(Date.now() + 1000);
			expect(opened).toHaveLength(1);
			expect(ended).toEqual(opened);
			expect(entry.pendingUiRequests.size).toBe(0);
		});
	});

	test("formDialog's timeout calls onTimeout and a late answer changes nothing", async () => {
		await withBrowserPresence({ localStream: true, callbackBrowsers: 0 }, async () => {
			respond = () => HOLD;
			const ui = buildUiContext(entry);
			let timeouts = 0;
			const result = await ui.formDialog!(ASK_FORM_HTML, {
				timeout: 30,
				onTimeout: () => timeouts++,
			});
			expect(result).toEqual({ data: defaultFormData(form), timedOut: true });
			expect(timeouts).toBe(1);
			expect(entry.pendingUiRequests.size).toBe(0);
		});
	});

	test("an answer before the deadline wins and stops the timer", async () => {
		await withBrowserPresence({ localStream: true, callbackBrowsers: 0 }, async () => {
			const ui = buildUiContext(entry);
			let timeouts = 0;
			const result = await ui.formDialog!(ASK_FORM_HTML, {
				timeout: 40,
				onTimeout: () => timeouts++,
			});
			expect(result).toEqual({ data: REDIS_DATA });
			// An answer before the deadline never reaches onTimeout.
			expect(timeouts).toBe(0);
		});
	});

	test("notes on chosen options reach the model as the SDK's Option notes block", async () => {
		await withBrowserPresence({ localStream: true, callbackBrowsers: 0 }, async () => {
			const answers = SUBMIT_REDIS.answers;
			respond = () => ({
				kind: "submit",
				answers: [
					{ ...answers[0], notes: [{ option: 1, text: "needs a\nservice" }] },
					{
						...answers[1],
						// A note on lint, which is not checked, is a draft: never sent on.
						notes: [
							{ option: 0, text: "strict" },
							{ option: 1, text: "draft" },
						],
					},
					answers[2],
					answers[3],
				],
			});
			const { texts, details } = await runAskTool();

			const notes = [
				{
					name: "store",
					question: "Pick a store?",
					option: "Redis",
					value: "redis",
					text: "needs a\nservice",
				},
				{ name: "checks", question: "Checks", option: "types", value: "types", text: "strict" },
			];
			expect(details).toEqual({ answers: formAnswers(form, REDIS_DATA), notes });
			expect(texts).toEqual([
				[
					"User answers:",
					JSON.stringify(REDIS_DATA, null, 2),
					"Option notes:",
					'- Pick a store?: Redis [store="redis"] — needs a service',
					'- Checks: types [checks="types"] — strict',
				].join("\n"),
			]);

			// formDialog itself: the data plus the notes, the shape the SDK's TUI dialog returns.
			const result = await buildUiContext(entry).formDialog!(ASK_FORM_HTML);
			expect(result).toEqual({ data: REDIS_DATA, notes });
		});
	});

	test("Stop cancels a pending ask: the dialog ends and the turn does not hang", async () => {
		await withBrowserPresence({ localStream: true, callbackBrowsers: 0 }, async () => {
			const opened: string[] = [];
			const ended: string[] = [];
			setOnFrameTap((frame) => {
				if (frame.type === "ui_request" && frame.method === "formDialog") {
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

	test("priming replays an open ask to a late client but never browser_ui requests", async () => {
		await withBrowserPresence({ localStream: true, callbackBrowsers: 0 }, async () => {
			respond = () => HOLD;
			const ui = buildUiContext(entry);
			const open = ui.formDialog!(ASK_FORM_HTML);
			await presented.promise;
			try {
				const { promise, resolve, reject } = Promise.withResolvers<unknown>();
				promise.catch(() => {});
				entry.pendingUiRequests.set("ui901", {
					streams: new Set<ClientConsumer>(),
					method: "browser_ui",
					params: {},
					resolve,
					reject,
				});
				// A real open form: the same params a client attached now would be primed with.
				const frames = pendingUiRequestFrames(entry);
				expect(frames).toHaveLength(1);
				expect(frames[0]).toMatchObject({ type: "ui_request", method: "formDialog" });
				expect(frames[0]).toEqual({
					type: "ui_request",
					id: expect.any(String),
					method: "formDialog",
					params: capturedForm,
				});
			} finally {
				entry.pendingUiRequests.delete("ui901");
				cancelEntryUiRequests(entry);
			}
			expect(await open).toBeUndefined();
		});
	});
});

describe("a collab guest answering the form", () => {
	/** A writable guest whose answers come from `script(draft, index)`; records every draft it saw. */
	function guest(script: (draft: CollabUiRequestDraft, index: number) => string | undefined): {
		adapter: CollabHostAdapter;
		drafts: CollabUiRequestDraft[];
	} {
		const drafts: CollabUiRequestDraft[] = [];
		const adapter = {
			isLive: true,
			writableGuestCount: 1,
			hostName: "host",
			announceDialogAnswered: () => {},
			requestGuestUi: (draft: CollabUiRequestDraft) => {
				drafts.push(draft);
				return Promise.resolve({
					kind: "answered",
					value: script(draft, drafts.length - 1),
					by: "guest",
					peer: 2,
				});
			},
		} as unknown as CollabHostAdapter;
		return { adapter, drafts };
	}

	test("walks every named field: a select per choice group, an editor per text field, re-asked until valid", async () => {
		await withBrowserPresence({ localStream: false, callbackBrowsers: 0 }, async () => {
			const answers = [
				"Other (type your own)", // store: pick the free-text row
				"mysql", // ... and type it
				"lint", // checks: toggle lint on
				"Next →",
				"500", // days: out of range
				"45", // ... re-asked with the error
				"bye", // notes
			];
			const { adapter, drafts } = guest((_draft, i) => answers[i]);
			entry.collab.adapter = adapter;

			const { texts } = await runAskTool();

			// The walk never reached the web: no formDialog frame was needed for the guest.
			expect(drafts).toEqual([
				{
					kind: "select",
					title: "Pick a store?",
					options: ["SQLite", "Redis", "Other (type your own)"],
					initialIndex: 0,
					selectionMarker: "radio",
				},
				{ kind: "editor", title: "Pick a store?", prefill: "" },
				{
					kind: "select",
					title: "Checks",
					options: ["types", "lint", "test", "Other (type your own)", "Next →"],
					selectionMarker: "checkbox",
					checkedIndices: [0],
					markableCount: 4,
				},
				{
					kind: "select",
					title: "Checks",
					options: ["types", "lint", "test", "Other (type your own)", "Next →"],
					selectionMarker: "checkbox",
					checkedIndices: [0, 1],
					markableCount: 4,
				},
				{ kind: "editor", title: "Days", prefill: "30" },
				{ kind: "editor", title: "Days (Must be at most 90)", prefill: "500" },
				{ kind: "editor", title: "Notes", prefill: "hello" },
			]);
			expect(texts).toEqual([
				`User answers:\n${JSON.stringify(
					{ source: "ui", store: "mysql", checks: ["types", "lint"], days: 45, notes: "bye" },
					null,
					2,
				)}`,
			]);
		});
	});

	test("a guest cancel cancels the ask; a cancelled Other editor returns to the options", async () => {
		await withBrowserPresence({ localStream: false, callbackBrowsers: 0 }, async () => {
			const answers: Array<string | undefined> = ["Other (type your own)", undefined, undefined];
			const { adapter, drafts } = guest((_draft, i) => answers[i]);
			entry.collab.adapter = adapter;
			await expect(runAskTool()).rejects.toThrow(/cancelled by the user/);
			// select, Other editor (cancelled), the options again (cancelled: the whole dialog).
			expect(drafts.map((d) => d.kind)).toEqual(["select", "editor", "select"]);
		});
	});

	test("the browser answering first closes the guest's walk", async () => {
		await withBrowserPresence({ localStream: true, callbackBrowsers: 0 }, async () => {
			let guestAborted = false;
			entry.collab.adapter = {
				isLive: true,
				writableGuestCount: 1,
				hostName: "host",
				announceDialogAnswered: () => {},
				requestGuestUi: (_draft: unknown, signal: AbortSignal) => {
					const { promise, resolve } = Promise.withResolvers<{ kind: "unavailable" }>();
					signal.addEventListener("abort", () => {
						guestAborted = true;
						resolve({ kind: "unavailable" });
					});
					return promise;
				},
			} as unknown as CollabHostAdapter;

			const { texts } = await runAskTool();
			expect(texts).toEqual([`User answers:\n${JSON.stringify(REDIS_DATA, null, 2)}`]);
			expect(guestAborted).toBe(true);
		});
	});
});
