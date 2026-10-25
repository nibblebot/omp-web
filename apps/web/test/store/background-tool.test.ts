/**
 * A bash, eval or task call that returned while its job keeps running stays parked on the
 * job. These tests drive the session's real producer (`toWireEvent`, late-join priming) into
 * the web's real `applyEvent`: the SDK keeps sending `tool_execution_update` frames for the
 * call after `tool_execution_end`, each carrying `details.async`, and the card follows the
 * job to its last state.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { WireSessionEvent } from "#lib/wire/protocol";
import type { SessionEntry } from "../../../session/session-entry";
import { streamingPrimeFrames, toWireEvent } from "../../../session/client-delivery";
import { loadHistory, setState, state } from "../../state";
import { applyEvent } from "../../store/chat";
import type { ToolItem } from "../../state";

async function tick(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

let nextHandle = 0;
function freshEntry(): SessionEntry {
	return { handle: `background-tool-${nextHandle++}` } as SessionEntry;
}

const CALL = "call_bg";

const started = (name: string): AgentSessionEvent =>
	({
		type: "tool_execution_start",
		toolCallId: CALL,
		toolName: name,
		args: {},
	}) as unknown as AgentSessionEvent;

type JobState = "running" | "completed" | "failed" | "cancelled";

function asyncDetails(
	state: JobState,
	type: string,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return { ...extra, async: { state, jobId: "bg_1", type } };
}

function returned(
	name: string,
	details: unknown,
	text = "Backgrounded as job bg_1",
): AgentSessionEvent {
	return {
		type: "tool_execution_end",
		toolCallId: CALL,
		toolName: name,
		result: { content: [{ type: "text", text }], details },
	} as unknown as AgentSessionEvent;
}

/** The job's frame, as the SDK reports it after the call returned. */
function frame(name: string, text: string, details: unknown): AgentSessionEvent {
	return {
		type: "tool_execution_update",
		toolCallId: CALL,
		toolName: name,
		args: {},
		partialResult: { content: [{ type: "text", text }], details },
	} as unknown as AgentSessionEvent;
}

function deliver(entry: SessionEntry, event: AgentSessionEvent): void {
	const wire = toWireEvent(entry.handle, event);
	if (wire !== null) applyEvent(JSON.parse(JSON.stringify(wire)) as WireSessionEvent);
}

function card(): ToolItem {
	const item = state.items.find((it) => it.kind === "tool");
	if (item?.kind !== "tool") throw new Error("no tool card");
	return item;
}

afterEach(() => {
	setState("items", []);
	setState("streaming", false);
});

describe("a backgrounded call's card follows its job", () => {
	test("returns parked: the call is done, the job runs", async () => {
		const entry = freshEntry();
		deliver(entry, started("bash"));
		deliver(entry, returned("bash", asyncDetails("running", "bash")));
		await tick();
		expect(card()).toMatchObject({
			status: "done",
			output: "Backgrounded as job bg_1",
			background: { jobId: "bg_1", type: "bash", state: "running", jobIds: ["bg_1"] },
		});
	});

	test("later frames fill the card; a completed frame settles it done with the job's result", async () => {
		const entry = freshEntry();
		deliver(entry, started("bash"));
		deliver(entry, returned("bash", asyncDetails("running", "bash")));
		deliver(entry, frame("bash", "step 1\n", asyncDetails("running", "bash")));
		await tick();
		expect(card().output).toBe("step 1\n");
		expect(card().background?.state).toBe("running");

		deliver(entry, frame("bash", "step 1\nstep 2\n", asyncDetails("running", "bash")));
		await tick();
		expect(card().output).toBe("step 1\nstep 2\n");

		deliver(entry, frame("bash", "all done", asyncDetails("completed", "bash")));
		await tick();
		expect(card()).toMatchObject({
			status: "done",
			output: "all done",
			background: { state: "completed" },
		});
		expect(card().background?.durationMs).toBeGreaterThanOrEqual(0);
	});

	test("a failed frame settles the card as an error and keeps the exit code", async () => {
		const entry = freshEntry();
		deliver(entry, started("bash"));
		deliver(entry, returned("bash", asyncDetails("running", "bash")));
		deliver(entry, frame("bash", "partial\n", asyncDetails("running", "bash")));
		deliver(
			entry,
			frame(
				"bash",
				"boom\n\nCommand exited with code 2",
				asyncDetails("failed", "bash", { exitCode: 2 }),
			),
		);
		await tick();
		expect(card()).toMatchObject({
			status: "error",
			output: "boom\n\nCommand exited with code 2",
			background: { state: "failed", exitCode: 2 },
		});
	});

	test("a cancelled frame interrupts the card and keeps the output it got to", async () => {
		const entry = freshEntry();
		deliver(entry, started("bash"));
		deliver(entry, returned("bash", asyncDetails("running", "bash")));
		deliver(entry, frame("bash", "partial output\n", asyncDetails("running", "bash")));
		await tick();
		deliver(entry, frame("bash", "Command aborted", asyncDetails("cancelled", "bash")));
		await tick();
		expect(card()).toMatchObject({
			status: "interrupted",
			output: "partial output\n",
			background: { state: "cancelled" },
		});
	});

	test("frames in one flush settle the card with the last output", async () => {
		const entry = freshEntry();
		deliver(entry, started("bash"));
		deliver(entry, returned("bash", asyncDetails("running", "bash")));
		deliver(entry, frame("bash", "a", asyncDetails("running", "bash")));
		deliver(entry, frame("bash", "ab", asyncDetails("running", "bash")));
		deliver(entry, frame("bash", "final", asyncDetails("completed", "bash")));
		await tick();
		expect(card()).toMatchObject({
			status: "done",
			output: "final",
			background: { state: "completed" },
		});
	});

	test("an eval cell follows its job the same way, with its live status", async () => {
		const entry = freshEntry();
		deliver(entry, started("eval"));
		deliver(entry, returned("eval", asyncDetails("running", "eval")));
		deliver(
			entry,
			frame(
				"eval",
				"tick 0",
				asyncDetails("running", "eval", { statusEvents: [{ op: "log", message: "tick" }] }),
			),
		);
		await tick();
		expect(card().live).toMatchObject({ kind: "eval", status: [{ op: "log", message: "tick" }] });
		deliver(entry, frame("eval", "ok", asyncDetails("completed", "eval")));
		await tick();
		expect(card()).toMatchObject({
			status: "done",
			output: "ok",
			background: { state: "completed" },
		});
	});

	test("a task call settles from the aggregate state of its spawns", async () => {
		const entry = freshEntry();
		const progress = [
			{ id: "Anna", status: "running" },
			{ id: "Bram", status: "running" },
		];
		deliver(entry, started("task"));
		deliver(
			entry,
			returned("task", asyncDetails("running", "task", { progress }), "Started 2 agents"),
		);
		await tick();
		expect(card().background?.jobIds).toEqual(["bg_1", "Anna", "Bram"]);
		deliver(
			entry,
			frame("task", "Background task Anna failed.", asyncDetails("failed", "task", { progress })),
		);
		await tick();
		expect(card()).toMatchObject({ status: "error", background: { state: "failed" } });
	});

	test("an update with only the job's new state still reaches the card", async () => {
		const entry = freshEntry();
		deliver(entry, started("bash"));
		deliver(entry, returned("bash", asyncDetails("running", "bash")));
		deliver(entry, frame("bash", "same", asyncDetails("running", "bash")));
		await tick();
		deliver(entry, frame("bash", "same", asyncDetails("completed", "bash")));
		await tick();
		expect(card()).toMatchObject({
			status: "done",
			output: "same",
			background: { state: "completed" },
		});
	});

	test("a call that returned with its job already over is a plain settled card", async () => {
		const entry = freshEntry();
		deliver(entry, started("bash"));
		deliver(entry, returned("bash", asyncDetails("completed", "bash"), "finished"));
		await tick();
		expect(card().background).toBeUndefined();
		expect(card().status).toBe("done");
	});

	test("the delivery settles a card whose frames never arrived", async () => {
		const entry = freshEntry();
		deliver(entry, started("bash"));
		deliver(entry, returned("bash", asyncDetails("running", "bash")));
		applyEvent({
			type: "message_end",
			message: {
				role: "custom",
				customType: "async-result",
				display: true,
				details: { jobs: [{ jobId: "bg_1", status: "failed", durationMs: 800 }] },
			},
		} as unknown as WireSessionEvent);
		expect(card()).toMatchObject({
			status: "error",
			background: { state: "failed", durationMs: 800 },
		});
	});

	test("a late joiner is primed with the job's last frame of an unsettled job", () => {
		const entry = freshEntry();
		toWireEvent(entry.handle, returned("bash", asyncDetails("running", "bash")));
		toWireEvent(entry.handle, frame("bash", "so far\n", asyncDetails("running", "bash")));
		expect(streamingPrimeFrames(entry)).toEqual([
			{
				type: "event",
				event: {
					type: "tool_execution_update",
					toolCallId: CALL,
					toolName: "bash",
					output: "so far\n",
					async: { state: "running" },
				},
			},
		]);
	});
});

describe("a job frame that beats the call's return", () => {
	test("settles the card with the frame's output, though the buffered partial flushed first", async () => {
		const entry = freshEntry();
		deliver(entry, started("bash"));
		deliver(entry, frame("bash", "job output", asyncDetails("completed", "bash")));
		await tick();
		deliver(entry, returned("bash", asyncDetails("running", "bash")));
		await tick();
		expect(card()).toMatchObject({
			status: "done",
			output: "job output",
			background: { state: "completed" },
		});
	});

	test("a failed frame keeps its exit code; a cancelled one the output the card got to", async () => {
		const failedEntry = freshEntry();
		deliver(failedEntry, started("bash"));
		deliver(failedEntry, frame("bash", "boom", asyncDetails("failed", "bash", { exitCode: 4 })));
		await tick();
		deliver(failedEntry, returned("bash", asyncDetails("running", "bash")));
		expect(card()).toMatchObject({
			status: "error",
			output: "boom",
			background: { state: "failed", exitCode: 4 },
		});

		setState("items", []);
		const cancelledEntry = freshEntry();
		deliver(cancelledEntry, started("bash"));
		deliver(cancelledEntry, frame("bash", "got this far", asyncDetails("running", "bash")));
		await tick();
		deliver(cancelledEntry, frame("bash", "Command aborted", asyncDetails("cancelled", "bash")));
		await tick();
		deliver(cancelledEntry, returned("bash", asyncDetails("running", "bash")));
		expect(card()).toMatchObject({
			status: "interrupted",
			output: "got this far",
			background: { state: "cancelled" },
		});
	});
});

describe("a cancelled frame", () => {
	test("never overwrites a chunk still buffered for the card", async () => {
		const entry = freshEntry();
		deliver(entry, started("bash"));
		deliver(entry, returned("bash", asyncDetails("running", "bash")));
		await tick();
		deliver(entry, frame("bash", "A", asyncDetails("running", "bash")));
		deliver(entry, frame("bash", "AB", asyncDetails("running", "bash")));
		deliver(entry, frame("bash", "Command aborted", asyncDetails("cancelled", "bash")));
		await tick();
		expect(card()).toMatchObject({
			status: "interrupted",
			output: "AB",
			background: { state: "cancelled" },
		});
	});
});

describe("a reloaded transcript", () => {
	const assistant = {
		role: "assistant",
		content: [{ type: "toolCall", id: CALL, name: "bash", arguments: { command: "sleep 9" } }],
		stopReason: "toolUse",
	} as unknown as AssistantMessage;
	const user: UserMessage = { role: "user", content: "go", timestamp: 1 };
	const startResult = {
		role: "toolResult",
		toolCallId: CALL,
		toolName: "bash",
		content: [{ type: "text", text: "Backgrounded as job bg_1" }],
		isError: false,
		details: asyncDetails("running", "bash"),
		timestamp: 2,
	} as unknown as ToolResultMessage;

	test("shows the final state from a later async-result", () => {
		loadHistory([
			user,
			assistant,
			startResult,
			{
				role: "custom",
				customType: "async-result",
				display: true,
				details: { jobs: [{ jobId: "bg_1", status: "completed", durationMs: 9000 }] },
			} as never,
		]);
		expect(card()).toMatchObject({
			status: "done",
			background: { state: "completed", durationMs: 9000 },
		});
	});

	test("a job nothing reports on stays a done card with its start text, never a made-up state", async () => {
		loadHistory([user, assistant, startResult]);
		expect(card().background?.state).toBe("running");
		// This file never mocks the transport, so the job list call fails offline and the outcome is unknowable.
		for (let i = 0; i < 10; i++) await Promise.resolve();
		expect(card()).toMatchObject({ status: "done", output: "Backgrounded as job bg_1" });
		expect(card().background).toBeUndefined();
	});
});
