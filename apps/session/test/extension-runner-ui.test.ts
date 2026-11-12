/**
 * A web session gives the SDK's extension runner the browser UI context, as the SDK's own hosts
 * do: extension handlers' `ctx.ui` dialogs (and the SDK's own prompts that ask through the
 * runner, such as the saved-reset question) become `ui_request` dialogs answered in the browser,
 * from boot and across a session change. With nobody attached a dialog fails at once instead of
 * waiting, and presentation or terminal-only hooks never fail the extension or the session.
 * A real AgentSession runs with inline extensions; a frame tap plays the browser.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as sdk from "@oh-my-pi/pi-coding-agent";
import type { ExtensionContext, ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { initSdkTuiGlobals } from "../sdk-tui-globals";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { browserUiPrimeFrames } from "../browser-ui";
import { setOnFrameTap, streams, type ClientConsumer } from "../client-delivery";
import { createCollabSession } from "../collab-session";
import type { SessionEntry } from "../session-entry";
import { openDialogIds, setCallbackBrowserStreamCount } from "../ui-context";

interface Outcome {
	event: string;
	answer?: boolean;
	error?: string;
}

const outcomes: Outcome[] = [];

/** Asks the user from its session handlers and records what each confirm settled to. */
const probe: ExtensionFactory = (api) => {
	const ask = async (event: string, ctx: ExtensionContext): Promise<void> => {
		try {
			outcomes.push({ event, answer: await ctx.ui.confirm(`Confirm on ${event}`, "Proceed?") });
		} catch (err) {
			outcomes.push({ event, error: err instanceof Error ? err.message : String(err) });
		}
	};
	api.on("session_start", (_event, ctx) => ask("session_start", ctx));
	api.on("session_switch", (_event, ctx) => ask("session_switch", ctx));
};

/** What a terminal-written extension's un-awaited startup work saw; set once it ran to the end. */
let hookRun: { theme: string; editorText: string; custom: unknown } | undefined;
const hookRunDone = Promise.withResolvers<void>();

/**
 * Calls the presentation and terminal-only hooks at session start, from async work nobody
 * awaits, as installed extensions do: a throw here would be an unhandled rejection.
 */
const terminalHooks: ExtensionFactory = (api) => {
	api.on("session_start", (_event, ctx) => {
		void (async () => {
			ctx.ui.setStatus("probe", "Indexing…");
			ctx.ui.setWidget("probe", ["one", "two"]);
			ctx.ui.setWidget("probe-tui", () => ({ render: () => [], invalidate: () => {} }) as never);
			ctx.ui.setWorkingMessage("Working…");
			ctx.ui.setTitle("probe");
			const theme = typeof ctx.ui.theme;
			ctx.ui.setFooter(undefined);
			ctx.ui.setHeader(() => ({ render: () => [], invalidate: () => {} }) as never);
			ctx.ui.pasteToEditor("draft");
			ctx.ui.setEditorText("draft");
			const editorText = ctx.ui.getEditorText();
			ctx.ui.onTerminalInput(() => undefined)();
			ctx.ui.setToolsExpanded(ctx.ui.getToolsExpanded());
			await ctx.ui.setTheme("dark");
			const custom = await ctx.ui.custom(
				() => ({ render: () => [], invalidate: () => {} }) as never,
			);
			hookRun = { theme, editorText, custom };
			hookRunDone.resolve();
		})();
	});
};

const unhandled: unknown[] = [];
/** A rejection nobody handled; it also ends the wait for the hook run, which then never finishes. */
const onUnhandled = (reason: unknown): void => {
	unhandled.push(reason);
	hookRunDone.resolve();
};
const errorLines: string[] = [];

const consumer = {
	id: 1,
	ws: { readyState: 1, getBufferedAmount: () => 0, send: () => 1, close: () => {} } as never,
	attached: "s1",
	lastSendAt: 0,
} as ClientConsumer;

let entry: SessionEntry;
const seen: Array<{ method: string; params: unknown }> = [];

/**
 * Run `act` with a browser attached that answers every dialog with `answer(method, params)`;
 * browser_ui contributions stay up, as a browser shows them until the user acts on one.
 */
async function withBrowser<T>(
	answer: (method: string, params: unknown) => unknown,
	act: () => Promise<T>,
): Promise<T> {
	seen.length = 0;
	consumer.attached = entry.handle;
	streams.add(consumer);
	setOnFrameTap((frame) => {
		if (frame.type !== "ui_request") return;
		seen.push({ method: frame.method, params: frame.params });
		if (frame.method === "browser_ui") return;
		const pending = entry.pendingUiRequests.get(frame.id);
		if (!pending) return;
		entry.pendingUiRequests.delete(frame.id);
		pending.resolve(answer(frame.method, frame.params));
	});
	try {
		return await act();
	} finally {
		streams.delete(consumer);
		setOnFrameTap(null);
	}
}

const previousAgentDir = getAgentDir();
const previousAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const previousNotifications = process.env.PI_NOTIFICATIONS;

beforeAll(async () => {
	// A real session reads the agent dir (auth storage, model catalog); keep it off the real one.
	setAgentDir(tempDir("omp-extension-ui-agent-"));
	// The session process's boot step that loads the theme extensions read.
	initSdkTuiGlobals();
	process.on("unhandledRejection", onUnhandled);
	const consoleError = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		errorLines.push(args.map(String).join(" "));
	});
	setCallbackBrowserStreamCount(() => 0);
	const cwd = tempDir("omp-extension-ui-");
	const realCreate = sdk.createAgentSession;
	const create = spyOn(sdk, "createAgentSession").mockImplementation(((
		options: Parameters<typeof sdk.createAgentSession>[0],
	) =>
		realCreate({
			...options,
			authStorage: undefined,
			modelRegistry: undefined,
			settings: sdk.Settings.isolated(),
			sessionManager: SessionManager.inMemory(cwd),
			extensions: [probe, terminalHooks],
			disableExtensionDiscovery: true,
			enableLsp: false,
		})) as typeof sdk.createAgentSession);
	try {
		const collab = createCollabSession({
			config: { idleTimeoutMs: 0 } as never,
			agentDir: cwd,
			authStorage: {} as never,
			modelRegistry: {} as never,
			settings: {} as never,
			broker: {
				broadcastState: async () => {},
				broadcastAvailableCommands: async () => {},
			} as never,
		});
		entry = await collab.createSession(cwd);
		await hookRunDone.promise;
	} finally {
		create.mockRestore();
		consoleError.mockRestore();
	}
});

afterAll(async () => {
	process.off("unhandledRejection", onUnhandled);
	streams.delete(consumer);
	setOnFrameTap(null);
	setCallbackBrowserStreamCount(null);
	await entry?.session.dispose();
	setAgentDir(previousAgentDir);
	if (previousAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDirEnv;
	if (previousNotifications === undefined) delete process.env.PI_NOTIFICATIONS;
	else process.env.PI_NOTIFICATIONS = previousNotifications;
	cleanupTempDirs();
});

describe("extension prompts in a web session", () => {
	test("the booted session's extensions have a prompt UI", () => {
		expect(entry.session.extensionRunner?.hasUI()).toBe(true);
	});

	test("terminal hooks called at start with nobody attached neither throw nor fail the session", () => {
		expect(hookRun).toEqual({ theme: "object", editorText: "", custom: undefined });
		expect(unhandled).toEqual([]);
		expect(errorLines).toEqual([]);
		expect(entry.pendingUiRequests.size).toBe(0);
	});

	test("with nobody attached, a boot-time confirm fails at once instead of waiting", () => {
		expect(outcomes).toEqual([
			{ event: "session_start", error: "No connected client to answer the UI request" },
		]);
		expect(entry.pendingUiRequests.size).toBe(0);
	});

	test("after a new session, an extension's confirm is a browser dialog and gets its answer", async () => {
		outcomes.length = 0;
		const created = await withBrowser(
			(method) => (method === "confirm" ? true : undefined),
			() => entry.session.newSession(),
		);

		expect(created).toBe(true);
		expect(entry.session.extensionRunner?.hasUI()).toBe(true);
		expect(seen).toEqual([
			{ method: "confirm", params: { title: "Confirm on session_switch", message: "Proceed?" } },
		]);
		expect(outcomes).toEqual([{ event: "session_switch", answer: true }]);
	});

	test("a dismissed browser confirm reads as no", async () => {
		outcomes.length = 0;
		await withBrowser(
			() => undefined,
			() => entry.session.newSession(),
		);

		expect(outcomes).toEqual([{ event: "session_switch", answer: false }]);
	});

	test("the saved-reset question's options reach the browser and No comes back as picked", async () => {
		// The shape AgentSession asks a saved-reset spend with: a select of described Yes/No items.
		const options = [
			{ label: "Yes", description: "Redeem now and set the window to yes." },
			{ label: "No", description: "Do not redeem, and set the window to no." },
		];
		const choice = await withBrowser(
			() => "No",
			() => entry.session.extensionRunner!.getUIContext().select("Spend a saved reset?", options),
		);

		expect(seen).toEqual([
			{ method: "select", params: { title: "Spend a saved reset?", options } },
		]);
		expect(choice).toBe("No");
	});

	test("with a browser attached, status updates replace each other quietly and clear", async () => {
		const errors = spyOn(console, "error");
		try {
			await withBrowser(
				() => undefined,
				async () => {
					const ui = entry.session.extensionRunner!.getUIContext();
					ui.setStatus("kata", "1 open issue");
					ui.setStatus("kata", "2 open issues");
					ui.setStatus("kata", undefined);
					// The replaced contributions' rejections settle within this turn of the loop.
					const settled = Promise.withResolvers<void>();
					setImmediate(settled.resolve);
					await settled.promise;
				},
			);

			const status = (text: string) => ({
				method: "browser_ui",
				params: expect.objectContaining({ payload: { blocks: [{ type: "text", text }] } }),
			});
			expect(seen).toEqual([status("1 open issue"), status("2 open issues")]);
			expect(entry.pendingUiRequests.size).toBe(0);
			expect(errors).not.toHaveBeenCalled();
		} finally {
			errors.mockRestore();
		}
	});
});

/** A primed browser_ui frame for one kept contribution showing `text`. */
function shown(id: string, text: string) {
	return expect.objectContaining({
		type: "ui_request",
		method: "browser_ui",
		params: expect.objectContaining({
			id,
			payload: expect.objectContaining({ blocks: [{ type: "text", text }] }),
		}),
	});
}

/** Prime a client the way an attach does, with that client attached. */
function primeClient() {
	consumer.attached = entry.handle;
	streams.add(consumer);
	try {
		return browserUiPrimeFrames(entry);
	} finally {
		streams.delete(consumer);
	}
}

describe("extension status, working message and widgets kept for later clients", () => {
	test("set at start with nobody attached, they reach the first client primed, and wait on no one", () => {
		expect(primeClient()).toEqual([
			shown("status:probe", "Indexing…"),
			expect.objectContaining({
				params: expect.objectContaining({
					id: "widget:probe",
					payload: expect.objectContaining({
						blocks: [
							{ type: "text", text: "one" },
							{ type: "text", text: "two" },
						],
					}),
				}),
			}),
			shown("working", "Working…"),
		]);
		// Live for that client to dismiss, yet no dialog: nothing blocks or holds idle exit.
		expect(entry.pendingUiRequests.size).toBe(3);
		expect(openDialogIds(entry)).toEqual([]);
	});

	test("a second client gets exactly the current set once, under the same request ids", () => {
		const first = primeClient();
		const second = primeClient();

		expect(second).toEqual(first);
		expect(second).toHaveLength(3);
		expect(entry.pendingUiRequests.size).toBe(3);
	});

	test("an update after attach replaces it for the attached client and for later ones", async () => {
		const [status] = primeClient();
		const shownId = status?.type === "ui_request" ? status.id : undefined;
		expect(shownId).toBeDefined();
		await withBrowser(
			() => undefined,
			async () => {
				// Colored with the terminal theme, as extensions do; the browser gets plain text.
				entry.session
					.extensionRunner!.getUIContext()
					.setStatus("probe", "\u001b[38;2;79;196;138mIndexed\u001b[39m");
			},
		);

		expect(seen).toEqual([
			{
				method: "browser_ui",
				params: expect.objectContaining({
					id: "status:probe",
					payload: { blocks: [{ type: "text", text: "Indexed" }] },
				}),
			},
		]);
		const after = primeClient();
		expect(after).toHaveLength(3);
		expect(after[2]).toEqual(shown("status:probe", "Indexed"));
		// The replaced copy ended: no client is primed with it and nobody can answer it.
		expect(after.some((frame) => frame.type === "ui_request" && frame.id === shownId)).toBe(false);
		expect(entry.pendingUiRequests.has(shownId!)).toBe(false);
	});

	test("one cleared before anyone attaches is never delivered", () => {
		const ui = entry.session.extensionRunner!.getUIContext();
		ui.setStatus("gone", "Briefly");
		ui.setStatus("gone", undefined);

		const frames = primeClient();
		expect(frames).toHaveLength(3);
		expect(frames).not.toContainEqual(shown("status:gone", "Briefly"));
	});
});
