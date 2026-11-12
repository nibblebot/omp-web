/**
 * Messages other agents send this session (`irc:incoming` custom messages,
 * SDK 18.18.9 and later also for a message that ends a `wait`): one transcript
 * card per delivery, from the reload (history) path and the live path, where the
 * SDK announces a delivery (`irc_message`) and later sends the same record as a
 * `message_end` when it joins the transcript. Hidden deliveries never render.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import * as solidWeb from "solid-js/web";
import type { ServerFrame } from "#lib/wire/protocol";
import { AgentMessageCard } from "../../components/chat/transcript/cards/AgentMessageCard";
import { connect, setState, state } from "../../state";
import type { AgentMessageItem } from "../../store/slices/agent-message";
import {
	FakeWebSocket,
	assistantMsg,
	attached,
	dispatch,
	installJsxShim,
	installTransportStubs,
	itemCounts,
	restoreBrowserGlobals,
	restoreJsxShim,
	userMsg,
} from "../web.testkit";

function agentMessage(
	id: string,
	from: string,
	body: string,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		role: "custom",
		customType: "irc:incoming",
		// The model-facing envelope; the card shows details.message.
		content: `<irc from="${from}">${body}</irc>`,
		display: true,
		details: { id, from, message: body },
		attribution: "agent",
		timestamp: 1_000,
		...extra,
	};
}

const ev = (event: unknown): ServerFrame => ({ type: "event", event }) as ServerFrame;
const history = (messages: unknown[]): ServerFrame =>
	({ type: "history", messages }) as ServerFrame;

function agentItems(): AgentMessageItem[] {
	return state.items.filter((it): it is AgentMessageItem => it.kind === "agentMessage");
}

beforeEach(() => {
	installTransportStubs();
	setState("items", []);
	connect();
	FakeWebSocket.instances.at(-1)!.onopen?.();
	dispatch(attached("session-a"));
});

afterEach(() => {
	setState("items", []);
	restoreBrowserGlobals();
});

describe("history", () => {
	test("a displayable agent message becomes a card with its sender and body, in transcript order", () => {
		dispatch(
			history([
				userMsg("fan out"),
				agentMessage("m1", "PreStyles", "base.css scrolls the pre"),
				assistantMsg("noted"),
			]),
		);
		expect(state.items.map((it) => it.kind)).toEqual(["user", "agentMessage", "assistant"]);
		expect(state.items[1]).toMatchObject({ from: "PreStyles", text: "base.css scrolls the pre" });
	});

	test("a hidden agent message (a parent's steer to a streaming subagent) stays out", () => {
		dispatch(history([userMsg("go"), agentMessage("m1", "main", "stop", { display: false })]));
		expect(state.items.map((it) => it.kind)).toEqual(["user"]);
	});
});

describe("live", () => {
	test("the delivery and the transcript entry of one message draw one card", () => {
		dispatch(history([]));
		const record = agentMessage("m1", "PreStyles", "base.css scrolls the pre");
		dispatch(ev({ type: "irc_message", message: record }));
		expect(agentItems()).toHaveLength(1);
		dispatch(ev({ type: "message_start", message: record }));
		dispatch(ev({ type: "message_end", message: record }));
		expect(itemCounts()).toEqual({ agentMessage: 1 });
		expect(agentItems()[0]).toMatchObject({ from: "PreStyles", text: "base.css scrolls the pre" });
	});

	test("a transcript entry with no delivery event first still draws its card once", () => {
		dispatch(history([]));
		const record = agentMessage("m1", "Reviewer", "lgtm");
		dispatch(ev({ type: "message_start", message: record }));
		dispatch(ev({ type: "message_end", message: record }));
		expect(itemCounts()).toEqual({ agentMessage: 1 });
	});

	test("two messages from the same sender are two cards", () => {
		dispatch(history([]));
		dispatch(ev({ type: "irc_message", message: agentMessage("m1", "Reviewer", "one") }));
		dispatch(ev({ type: "irc_message", message: agentMessage("m2", "Reviewer", "two") }));
		expect(agentItems().map((it) => it.text)).toEqual(["one", "two"]);
	});

	test("a hidden delivery draws nothing", () => {
		dispatch(history([]));
		const record = agentMessage("m1", "main", "stop", { display: false });
		dispatch(ev({ type: "irc_message", message: record }));
		dispatch(ev({ type: "message_end", message: record }));
		expect(state.items).toEqual([]);
	});

	test("a reload before the message joins the transcript still ends with one card", () => {
		dispatch(history([userMsg("go")]));
		const record = agentMessage("m1", "PreStyles", "heads up");
		dispatch(ev({ type: "irc_message", message: record }));
		// The resync's snapshot predates the entry: the card goes with it, then the entry draws it.
		dispatch(history([userMsg("go")]));
		dispatch(ev({ type: "message_end", message: record }));
		expect(itemCounts()).toEqual({ user: 1, agentMessage: 1 });
	});

	test("a reload that already holds the message keeps one card when the delivery repeats", () => {
		const record = agentMessage("m1", "PreStyles", "heads up");
		dispatch(history([userMsg("go"), record]));
		dispatch(ev({ type: "irc_message", message: record }));
		dispatch(ev({ type: "message_end", message: record }));
		expect(itemCounts()).toEqual({ user: 1, agentMessage: 1 });
	});
});

describe("AgentMessageCard", () => {
	beforeEach(() => installJsxShim());
	afterAll(restoreJsxShim);

	test("names the sender and shows the message", () => {
		const item: AgentMessageItem = {
			kind: "agentMessage",
			id: 1,
			key: "m1",
			from: "PreStyles",
			text: "Pin it on a wrapper.",
		};
		const html = solidWeb.renderToString(() => createComponent(AgentMessageCard, { item }));
		expect(html).toContain("Message from PreStyles");
		expect(html).toContain("Pin it on a wrapper.");
	});
});
