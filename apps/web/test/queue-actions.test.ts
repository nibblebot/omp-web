/**
 * Regression tests for the queue client actions (hs2p): a chip removes the
 * clicked message by identity, and an aborted turn reloads with its
 * Interrupted marker.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ClientCommand, QueuedCommandRef, QueuedMessageRef } from "#lib/wire/protocol";
import { rejectPendingCalls } from "../store/transport";
import {
	connect,
	deleteQueuedCommand,
	deleteQueuedMessage,
	editQueuedMessage,
	loadHistory,
	promptInsert,
	runQueuedCommandNow,
	setPromptInsert,
	setState,
	state,
} from "../state";
import {
	FakeEventSource,
	callResult,
	dispatch,
	flushMicrotasks,
	installTransportStubs,
	posted,
	restoreBrowserGlobals,
} from "./web.testkit";

function callsTo(method: string): Extract<ClientCommand, { type: "call" }>[] {
	return posted.filter(
		(c): c is Extract<ClientCommand, { type: "call" }> => c.type === "call" && c.method === method,
	);
}

beforeEach(() => {
	installTransportStubs();
	connect();
	FakeEventSource.instances.at(-1)!.onopen?.();
	posted.length = 0;
	setState({ streaming: true, queuedMessageCount: 2, pausedQueueCount: 0 });
});

afterEach(() => {
	rejectPendingCalls(new Error("test teardown"));
	restoreBrowserGlobals();
});

describe("queue chip removal", () => {
	test("delete posts takeQueued with the clicked chip's ref, never popLastQueuedMessage", async () => {
		const ref: QueuedMessageRef = { kind: "follow-up", text: "second", paused: 1 };
		const done = deleteQueuedMessage(ref);
		await flushMicrotasks();

		expect(callsTo("popLastQueuedMessage")).toEqual([]);
		const [cmd] = callsTo("takeQueued");
		expect(cmd?.args).toEqual([ref]);

		dispatch(callResult(cmd!.id, { text: "second" }));
		await done;
	});

	test("a queued command chip deletes with takeQueuedCommand and runs with runQueuedCommandNow", async () => {
		const ref: QueuedCommandRef = { index: 0, text: "/add-dir /tmp/x" };
		const removed = deleteQueuedCommand(ref);
		await flushMicrotasks();
		const [take] = callsTo("takeQueuedCommand");
		expect(take?.args).toEqual([ref]);
		dispatch(callResult(take!.id, undefined));
		await removed;

		const ran = runQueuedCommandNow(ref);
		await flushMicrotasks();
		const [run] = callsTo("runQueuedCommandNow");
		expect(run?.args).toEqual([ref]);
		dispatch(callResult(run!.id, undefined));
		await ran;
	});
});

describe("queued edit restores attachments", () => {
	test("edit moves a steer's text files back to chips and its images into the prompt", async () => {
		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		const ref: QueuedMessageRef = {
			kind: "steer",
			text: 'Match the spec\n\n<file path="spec.md">\n# Spec\n</file>',
		};
		const done = editQueuedMessage(ref);
		await flushMicrotasks();
		const [cmd] = callsTo("takeQueued");
		dispatch(callResult(cmd!.id, { text: ref.text, images: [image] }));
		await done;
		expect(promptInsert()).toEqual({
			text: "Match the spec",
			images: [image],
			files: [expect.objectContaining({ name: "spec.md", text: "# Spec" })],
		});
		setPromptInsert(null);
	});
});

describe("Interrupted footer", () => {
	test("a reloaded aborted assistant turn is marked interrupted", () => {
		loadHistory([
			{ role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "partial" }],
				stopReason: "aborted",
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				stopReason: "stop",
			},
		] as never);
		const assistants = state.items.filter((i) => i.kind === "assistant");
		expect(assistants.map((a) => (a.kind === "assistant" ? a.interrupted === true : null))).toEqual(
			[true, false],
		);
	});
});
