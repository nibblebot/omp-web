/** Subagent transcript tool status: idle settle and the abort relabel across pages read interrupted. */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as transport from "../../store/transport";

let pages: unknown[] = [];
let next = 0;
const originalTransport = { ...transport };
mock.module("../../store/transport", () => ({
	...originalTransport,
	call: async (method: string) =>
		method === "getSubagentMessages" ? pages[Math.min(next++, pages.length - 1)] : undefined,
}));

afterAll(() => {
	// mock.restore() leaves module mocks installed; reinstall the real exports for later files.
	mock.module("../../store/transport", () => originalTransport);
});

// Dynamic imports: the transport mock must be registered before the store module binds to it.
const { subagentTranscript, syncSubagentTranscript } = await import("../../store/subagents");
const { setState } = await import("../../state");

const settle = async () => {
	for (let i = 0; i < 30; i++) await Promise.resolve();
};

function pageOf(messages: unknown[], nextByte: number) {
	const entries = messages.map((message, index) => ({
		type: "message",
		id: `m${nextByte}-${index}`,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message,
	}));
	return {
		sessionFile: "/s/a.jsonl",
		fromByte: 0,
		nextByte,
		reset: false,
		hasMore: false,
		entries,
		messages,
	};
}

const assistantCalling = (id: string) => ({
	role: "assistant",
	content: [{ type: "toolCall", id, name: "bash", arguments: { command: "make" } }],
});
const errorResult = (id: string) => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "bash",
	content: [{ type: "text", text: "killed" }],
	isError: true,
	details: {},
});
const aborted = { role: "assistant", content: [], stopReason: "aborted" };

let agent = "";
let counter = 0;
beforeEach(() => {
	counter += 1;
	next = 0;
	agent = `agent-${counter}`;
	setState("currentWorkspaceId", `session-${counter}`);
});

function setAgent(status: string, lastUpdate: number, progress?: Record<string, unknown>): void {
	setState(
		"subagents",
		new Map([[agent, { id: agent, index: 0, agent: "task", status, lastUpdate, progress }]]),
	);
	syncSubagentTranscript(agent);
}

const statuses = () =>
	subagentTranscript(agent)
		.items.filter((item) => item.kind === "tool")
		.map((item) => item.status);

describe("subagent transcript tool status", () => {
	test("a call with no result stays running while the agent runs, interrupted once it settled", async () => {
		pages = [pageOf([assistantCalling("a")], 100), pageOf([], 100)];
		setAgent("running", 1);
		await settle();
		expect(statuses()).toEqual(["running"]);

		setAgent("completed", 2);
		await settle();
		expect(statuses()).toEqual(["interrupted"]);
	});

	test("an aborted message on a later page relabels the earlier page's error result", async () => {
		pages = [pageOf([assistantCalling("a"), errorResult("a")], 100), pageOf([aborted], 200)];
		setAgent("running", 1);
		await settle();
		expect(statuses()).toEqual(["error"]);

		// A finished request is what tells the pane the transcript grew.
		setAgent("running", 2, { requests: 1 });
		await settle();
		expect(statuses()).toEqual(["interrupted"]);
	});
	test("a call parked on a background job stays a plain done card once the agent settled", async () => {
		const parkedResult = {
			role: "toolResult",
			toolCallId: "a",
			toolName: "bash",
			content: [{ type: "text", text: "Backgrounded as job bg_1" }],
			isError: false,
			details: { async: { state: "running", jobId: "bg_1", type: "bash" } },
			timestamp: 5,
		};
		pages = [pageOf([assistantCalling("a"), parkedResult], 100), pageOf([], 100)];
		setAgent("running", 1);
		await settle();
		const card = () => subagentTranscript(agent).items.find((item) => item.kind === "tool");
		expect(card()?.kind === "tool" && card()?.background?.state).toBe("running");

		setAgent("completed", 2);
		await settle();
		expect(statuses()).toEqual(["done"]);
		expect(card()?.kind === "tool" && card()?.background).toBeUndefined();
	});
});
