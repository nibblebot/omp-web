/** Subagent transcripts are retained only while shown (plus a few closed ones) and per attached session. */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as transport from "../../store/transport";

interface Page {
	entries: unknown[];
	nextByte: number;
}
let pages: Record<string, Page[]> = {};
let reads: Array<{ id: string; fromByte: number }> = [];
let hold: Promise<void> | undefined;

const originalTransport = { ...transport };
mock.module("../../store/transport", () => ({
	...originalTransport,
	call: async (method: string, args: Array<{ subagentId: string; fromByte: number }>) => {
		if (method !== "getSubagentMessages") return undefined;
		const { subagentId, fromByte } = args[0];
		reads.push({ id: subagentId, fromByte });
		if (hold) await hold;
		const page = (pages[subagentId] ?? []).find((p) => p.nextByte > fromByte);
		return {
			sessionFile: "/s/a.jsonl",
			fromByte,
			nextByte: page?.nextByte ?? fromByte,
			reset: false,
			hasMore: false,
			entries: page?.entries ?? [],
			messages: [],
		};
	},
}));

afterAll(() => {
	mock.module("../../store/transport", () => originalTransport);
});

const {
	clearSubagentTranscripts,
	holdSubagentTranscript,
	subagentTranscript,
	syncSubagentTranscript,
} = await import("../../store/subagents");
const { setState } = await import("../../state");

const settle = async () => {
	for (let i = 0; i < 30; i++) await Promise.resolve();
};

const entry = (id: string, message: unknown) => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "2026-01-01T00:00:00.000Z",
	message,
});
const userSays = (text: string) =>
	entry(`u-${text}`, { role: "user", content: text, timestamp: 1 });
const assistantSays = (text: string) =>
	entry(`a-${text}`, { role: "assistant", content: [{ type: "text", text }] });
const assistantCalling = (id: string) =>
	entry(`c-${id}`, {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "bash", arguments: { command: "make" } }],
	});
const result = (id: string) =>
	entry(`r-${id}`, {
		role: "toolResult",
		toolCallId: id,
		toolName: "bash",
		content: [{ type: "text", text: "ok" }],
		isError: false,
	});

let session = 0;
beforeEach(() => {
	session += 1;
	setState("currentWorkspaceId", `retention-${session}`);
	setState("subagents", new Map());
	pages = {};
	reads = [];
	hold = undefined;
	clearSubagentTranscripts();
});

function setAgent(
	id: string,
	status: string,
	lastUpdate: number,
	progress?: Record<string, unknown>,
): void {
	setState("subagents", (prev) => {
		const next = new Map(prev);
		next.set(id, { id, index: 0, agent: "task", status, lastUpdate, progress });
		return next;
	});
}

async function open(id: string): Promise<() => void> {
	setAgent(id, "completed", 1);
	pages[id] = [{ entries: [userSays(`hello ${id}`), assistantSays("hi")], nextByte: 100 }];
	const release = holdSubagentTranscript(id);
	syncSubagentTranscript(id);
	await settle();
	return release;
}

describe("subagent transcript retention", () => {
	test("a transcript is kept while its pane is open, however many others close", async () => {
		const releaseOpen = await open("keep");
		for (const id of ["a", "b", "c", "d", "e"]) (await open(id))();
		expect(subagentTranscript("keep").items).toHaveLength(2);
		releaseOpen();
	});

	test("only the most recently closed transcripts stay resident", async () => {
		const ids = ["a", "b", "c", "d", "e"];
		for (const id of ids) (await open(id))();
		const resident = ids.filter((id) => subagentTranscript(id).items.length > 0);
		expect(resident).toEqual(["c", "d", "e"]);
	});

	test("reopening an evicted transcript loads it again from byte 0", async () => {
		for (const id of ["a", "b", "c", "d", "e"]) (await open(id))();
		reads = [];
		const release = holdSubagentTranscript("a");
		syncSubagentTranscript("a");
		await settle();
		expect(reads).toEqual([{ id: "a", fromByte: 0 }]);
		expect(subagentTranscript("a").items).toHaveLength(2);
		release();
	});

	test("a session switch drops every transcript, and a read still in flight does not bring one back", async () => {
		await open("a");
		expect(subagentTranscript("a").items).toHaveLength(2);
		let finish!: () => void;
		hold = new Promise<void>((resolve) => (finish = resolve));
		setAgent("b", "completed", 1);
		pages.b = [{ entries: [userSays("late")], nextByte: 50 }];
		syncSubagentTranscript("b");
		await settle();
		clearSubagentTranscripts();
		finish();
		await settle();
		expect(subagentTranscript("a").items).toHaveLength(0);
		expect(subagentTranscript("b").items).toHaveLength(0);
	});

	test("a revived agent appends to its transcript without losing what was loaded", async () => {
		setAgent("r", "completed", 1);
		pages.r = [
			{ entries: [userSays("go"), assistantCalling("t1"), result("t1")], nextByte: 100 },
			{ entries: [assistantSays("more")], nextByte: 200 },
		];
		syncSubagentTranscript("r");
		await settle();
		expect(subagentTranscript("r").items).toHaveLength(3);

		setAgent("r", "running", 2, { requests: 2 });
		syncSubagentTranscript("r");
		await settle();
		const items = subagentTranscript("r").items;
		expect(items.map((item) => item.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
		expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
	});

	test("progress frames that show no new transcript do not read it again", async () => {
		setAgent("p", "running", 1, { requests: 1, toolCount: 1 });
		pages.p = [{ entries: [userSays("go")], nextByte: 50 }];
		syncSubagentTranscript("p");
		await settle();
		expect(reads).toHaveLength(1);

		// Streaming ticks: only the clock and tokens move.
		for (let t = 2; t < 6; t++) {
			setAgent("p", "running", t * 1000, { requests: 1, toolCount: 1, durationMs: t * 1000 });
			syncSubagentTranscript("p");
			await settle();
		}
		expect(reads).toHaveLength(1);

		setAgent("p", "running", 7000, { requests: 2, toolCount: 1 });
		syncSubagentTranscript("p");
		await settle();
		expect(reads).toHaveLength(2);
	});
});
