/**
 * Store tests for the ShareSheet flows: the collab_start command shape (the
 * configured relay is used unless the user explicitly opts in to the public
 * one), the New-session confirm while a room is live, and guest prompt cards
 * in both the live event path and the reload (history) path.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { WireSessionEvent } from "#lib/wire/protocol";
import type { ClientCommand, CollabWireStatus } from "#lib/wire/protocol";
import {
	cancelDangerConfirm,
	confirmDangerConfirm,
	dangerConfirm,
} from "../../prompt/danger-confirm";
import { connect, loadHistory, setState, state } from "../../state";
import { applyEvent, startNewSession } from "../../store/chat";
import {
	PUBLIC_RELAY_URL,
	relayConfigured,
	startCollabRoom,
	stopCollabRoom,
} from "../../store/collab";
import {
	FakeWebSocket,
	callResult,
	dispatch,
	flushMicrotasks,
	installLocalStorageShim,
	installTransportStubs,
	posted,
	restoreBrowserGlobals,
} from "../web.testkit";

const LIVE: CollabWireStatus = {
	state: "live",
	link: "wss://relay.example/r/1#control",
	viewLink: "wss://relay.example/r/1#view",
	access: "control",
	relayUrl: "wss://relay.example",
	roomId: "1",
	maxGuests: 4,
	participants: [{ name: "host", role: "host" }],
};

/**
 * Reset the room status with a fresh literal. Writing the shared COLLAB_OFF
 * constant can be skipped by the store once it has held that object, which
 * leaves a previous LIVE status in place for the next test.
 */
function resetStatus(): void {
	setState({ collabStatus: { state: "off" }, items: [] });
}

function seedRelayUrl(value: string): void {
	const model = {
		tabs: [{ id: "interaction", groups: [{ items: [{ path: "collab.relayUrl", value }] }] }],
	};
	setState("settingsModel", model as never);
}

function guestPrompt(from: string, text: string): Record<string, unknown> {
	return {
		role: "custom",
		customType: "collab-prompt",
		display: true,
		content: text,
		details: { from },
		timestamp: 0,
	};
}

function collabCommands(): ClientCommand[] {
	return posted.filter((c) => c.type === "collab_start" || c.type === "collab_stop");
}

function newSessionCalls(): number {
	return posted.filter((c) => c.type === "call" && c.method === "newSession").length;
}

/** Answer the posted newSession call so its promise settles inside the test. */
function answerNewSession(): void {
	const pending = posted.find((c) => c.type === "call" && c.method === "newSession");
	if (pending?.type !== "call") throw new Error("newSession was not posted");
	dispatch(callResult(pending.id, undefined));
}

beforeEach(() => {
	installTransportStubs();
	installLocalStorageShim();
	connect();
	FakeWebSocket.instances.at(-1)?.onopen?.();
	resetStatus();
	posted.length = 0;
});

afterEach(() => {
	cancelDangerConfirm();
	resetStatus();
	setState({ settingsModel: null as never });
	restoreBrowserGlobals();
});

describe("relay opt-in", () => {
	test("an unset or public relay still needs the opt-in; a custom relay does not", () => {
		setState({ settingsModel: null as never });
		expect(relayConfigured()).toBe(false);
		seedRelayUrl("");
		expect(relayConfigured()).toBe(false);
		seedRelayUrl(PUBLIC_RELAY_URL);
		expect(relayConfigured()).toBe(false);
		seedRelayUrl("wss://relay.example");
		expect(relayConfigured()).toBe(true);
	});

	test("starting with the configured relay sends no relayUrl", () => {
		startCollabRoom("view");
		const [cmd] = collabCommands();
		expect(cmd).toMatchObject({ type: "collab_start", access: "view" });
		expect(cmd).not.toHaveProperty("relayUrl");
	});

	test("the public-relay opt-in sends it explicitly with the chosen access", () => {
		startCollabRoom("control", PUBLIC_RELAY_URL);
		expect(collabCommands()).toMatchObject([
			{ type: "collab_start", access: "control", relayUrl: PUBLIC_RELAY_URL },
		]);
	});

	test("stop posts collab_stop", () => {
		stopCollabRoom();
		expect(collabCommands().map((c) => c.type)).toEqual(["collab_stop"]);
	});
});

describe("New session while a room is live", () => {
	test("asks before ending the room and does not call newSession until confirmed", async () => {
		setState("collabStatus", LIVE);
		await startNewSession();
		expect(dangerConfirm()?.confirmLabel).toBe("End share and start new");
		expect(newSessionCalls()).toBe(0);

		confirmDangerConfirm();
		await flushMicrotasks();
		expect(newSessionCalls()).toBe(1);
		answerNewSession();
		await flushMicrotasks();
	});

	test("cancelling keeps the room and starts nothing", async () => {
		setState("collabStatus", LIVE);
		await startNewSession();
		cancelDangerConfirm();
		expect(dangerConfirm()).toBeNull();
		expect(newSessionCalls()).toBe(0);
	});

	test("without a live room it starts at once", async () => {
		const started = startNewSession();
		await flushMicrotasks();
		expect(dangerConfirm()).toBeNull();
		expect(newSessionCalls()).toBe(1);
		answerNewSession();
		await started;
	});
});

describe("guest prompt cards", () => {
	test("render live from a settled collab-prompt message", () => {
		applyEvent({
			type: "message_end",
			message: guestPrompt("ada", "run the tests"),
		} as unknown as WireSessionEvent);
		expect(state.items.map((i) => i.kind)).toEqual(["guestPrompt"]);
		expect(state.items[0]).toMatchObject({ from: "ada", text: "run the tests" });
	});

	test("render again after a reload, in transcript order", () => {
		loadHistory([
			{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 },
			guestPrompt("ada", "run the tests"),
			{ role: "assistant", content: [{ type: "text", text: "done" }] },
		] as unknown as AgentMessage[]);
		expect(state.items.map((i) => i.kind)).toEqual(["user", "guestPrompt", "assistant"]);
		expect(state.items[1]).toMatchObject({ from: "ada", text: "run the tests" });
	});

	test("hidden collab prompts stay out of the transcript on reload", () => {
		loadHistory([{ ...guestPrompt("ada", "secret"), display: false }] as unknown as AgentMessage[]);
		expect(state.items).toEqual([]);
	});
});
