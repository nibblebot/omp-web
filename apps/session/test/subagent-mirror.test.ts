import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "../session-entry";
import {
	clearSubagents,
	finishedSubagentMeta,
	finishedSubagentUsage,
	handleSubagentLifecycle,
	handleSubagentProgress,
	readSubagentTranscript,
} from "../subagent-mirror";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function transcript(lines: string[]): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "omp-worker-page-"));
	directories.push(directory);
	const path = join(directory, "worker.jsonl");
	await writeFile(path, lines.join("\n"));
	return path;
}

function message(id: string, text: string): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-10-05T00:00:00.000Z",
		message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
	});
}

/** The `details` of a transcript message, undefined when it has none. */
function detailsOf(message: unknown): unknown {
	return typeof message === "object" && message !== null && "details" in message
		? message.details
		: undefined;
}

function bashResult(
	toolName: string,
	id: string,
	details: Record<string, unknown>,
	text = "output",
): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-10-05T00:00:00.000Z",
		message: {
			role: "toolResult",
			toolCallId: `call-${id}`,
			toolName,
			content: [{ type: "text", text }],
			details,
			isError: false,
			timestamp: 0,
		},
	});
}

describe("bounded worker transcript pages", () => {
	test("complete UTF-8 records retain IDs across pages and do not duplicate anchors", async () => {
		const lines = [
			message("first", "é".repeat(280)),
			message("second", "second"),
			message("third", "z".repeat(700)),
			"",
		];
		const path = await transcript(lines);
		const first = await readSubagentTranscript(path, 0, 1024);
		expect(first.hasMore).toBe(true);
		expect(first.entries.map((entry) => entry.id)).toEqual(["first", "second"]);
		const second = await readSubagentTranscript(path, first.nextByte, 1024);
		expect(second.entries.map((entry) => entry.id)).toEqual(["third"]);
		expect(second.hasMore).toBe(false);
		expect(first.messages[0]).toMatchObject({ content: [{ type: "text", text: "é".repeat(280) }] });
	});

	test("incomplete trailing record remains unread until its newline arrives", async () => {
		const firstLine = message("first", "complete");
		const tail = message("tail", "partial");
		const path = await transcript([firstLine, tail]);
		const first = await readSubagentTranscript(path);
		expect(first.entries.map((entry) => entry.id)).toEqual(["first"]);
		await writeFile(path, `${firstLine}\n${tail}\n`);
		const next = await readSubagentTranscript(path, first.nextByte);
		expect(next.entries.map((entry) => entry.id)).toEqual(["tail"]);
	});

	test("truncation resets the byte cursor rather than returning a false empty history", async () => {
		const path = await transcript([message("new", "replacement"), ""]);
		const page = await readSubagentTranscript(path, 100000);
		expect(page.reset).toBe(true);
		expect(page.fromByte).toBe(0);
		expect(page.entries.map((entry) => entry.id)).toEqual(["new"]);
	});

	test("missing history and an oversized record are explicit refusals", async () => {
		const path = await transcript([message("large", "x".repeat(2000)), ""]);
		await expect(readSubagentTranscript(path, 0, 1024)).rejects.toThrow("record exceeds page size");
		await expect(readSubagentTranscript(`${path}.missing`)).rejects.toThrow("artifact unavailable");
		await expect(readSubagentTranscript(path, 0, 0)).rejects.toThrow("page size");
	});

	test("a bash result's shell trace is dropped, and a record only its trace made oversized still loads", async () => {
		const trace = { id: "run", events: "t".repeat(1024 * 1024) };
		const path = await transcript([
			message("first", "before"),
			bashResult("bash", "huge", { exitCode: 0, replies: ["out://1"], trace }),
			message("last", "after"),
			"",
		]);
		const first = await readSubagentTranscript(path, 0, 256 * 1024);
		expect(first.entries.map((entry) => entry.id)).toEqual(["first"]);
		expect(first.hasMore).toBe(true);
		const second = await readSubagentTranscript(path, first.nextByte, 256 * 1024);
		expect(second.entries.map((entry) => entry.id)).toEqual(["huge"]);
		expect(second.fromByte).toBe(first.nextByte);
		expect(second.nextByte).toBeGreaterThan(first.nextByte + 1024 * 1024);
		expect(second.hasMore).toBe(true);
		expect(second.messages.map(detailsOf)).toEqual([{ exitCode: 0, replies: ["out://1"] }]);
		expect(JSON.stringify(second.entries)).not.toContain("tttt");
		const third = await readSubagentTranscript(path, second.nextByte, 256 * 1024);
		expect(third.entries.map((entry) => entry.id)).toEqual(["last"]);
		expect(third.hasMore).toBe(false);
		// A trace inside a small page is dropped too; non-bash results keep their details.
		const small = await transcript([
			bashResult("bash", "small", { exitCode: 1, trace: { id: "run" } }),
			bashResult("read", "other", { trace: { id: "keep" } }),
			"",
		]);
		const page = await readSubagentTranscript(small);
		expect(page.messages.map(detailsOf)).toEqual([{ exitCode: 1 }, { trace: { id: "keep" } }]);
	});

	test("a record still over the page after its trace is stripped, or past the read cap, keeps the error", async () => {
		const path = await transcript([
			bashResult(
				"bash",
				"big",
				{ exitCode: 0, trace: { events: "t".repeat(5000) } },
				"x".repeat(2000),
			),
			"",
		]);
		await expect(readSubagentTranscript(path, 0, 1024)).rejects.toThrow("record exceeds page size");
		const beyondCap = await transcript([
			bashResult("bash", "cap", { exitCode: 0, trace: { events: "t".repeat(9 * 1024 * 1024) } }),
			"",
		]);
		await expect(readSubagentTranscript(beyondCap, 0, 1024)).rejects.toThrow(
			"record exceeds page size",
		);
	});
});

type LifecyclePayload = Parameters<typeof handleSubagentLifecycle>[1];
type ProgressPayload = Parameters<typeof handleSubagentProgress>[1];

function entryStub(): SessionEntry {
	return {
		subagentSnapshots: new Map(),
		transcriptSessionFilesBySubagentId: new Map(),
		staleSubagentIds: new Set(),
		handle: {},
	} as unknown as SessionEntry;
}

function lifecycle(status: string): LifecyclePayload {
	return { id: "a1", index: 0, agent: "task", status, parentToolCallId: "t1" } as LifecyclePayload;
}

/** Progress frame for the mirror's test agent; only the fields under test are set. */
function progressFrame(progress: Partial<ProgressPayload["progress"]>): ProgressPayload {
	return {
		index: 0,
		agent: "task",
		agentSource: "bundled",
		task: "t",
		parentToolCallId: "t1",
		progress,
	} as ProgressPayload;
}

describe("finished subagent usage", () => {
	test("a finished agent keeps its last reported usage after the live snapshot is dropped", () => {
		const entry = entryStub();
		handleSubagentLifecycle(entry, lifecycle("started"));
		handleSubagentProgress(
			entry,
			progressFrame({
				id: "a1",
				status: "running",
				recentTools: [],
				tokens: 1200,
				requests: 3,
				cost: 0.02,
			}),
		);
		expect(finishedSubagentUsage(entry, "a1")).toBeUndefined();
		handleSubagentLifecycle(entry, lifecycle("completed"));
		expect(entry.subagentSnapshots.has("a1")).toBe(false);
		expect(finishedSubagentUsage(entry, "a1")).toEqual({ tokens: 1200, requests: 3, cost: 0.02 });
	});

	test("an agent that never reported usage stays unknown, not zero", () => {
		const entry = entryStub();
		handleSubagentLifecycle(entry, lifecycle("started"));
		handleSubagentLifecycle(entry, lifecycle("completed"));
		expect(finishedSubagentUsage(entry, "a1")).toBeUndefined();
	});

	test("clearing the session drops retained usage", () => {
		const entry = entryStub();
		handleSubagentLifecycle(entry, lifecycle("started"));
		handleSubagentProgress(
			entry,
			progressFrame({
				id: "a1",
				status: "running",
				recentTools: [],
				tokens: 5,
				requests: 1,
				cost: 0,
			}),
		);
		handleSubagentLifecycle(entry, lifecycle("completed"));
		clearSubagents(entry);
		expect(finishedSubagentUsage(entry, "a1")).toBeUndefined();
	});
});

describe("finished subagent metadata", () => {
	test("a finished agent keeps its Task linkage; a restart clears it", () => {
		const entry = entryStub();
		handleSubagentLifecycle(entry, lifecycle("started"));
		handleSubagentProgress(
			entry,
			progressFrame({
				id: "a1",
				status: "running",
				recentTools: [],
				tokens: 1,
				requests: 1,
				cost: 0,
			}),
		);
		handleSubagentLifecycle(entry, lifecycle("completed"));
		expect(entry.subagentSnapshots.has("a1")).toBe(false);
		expect(finishedSubagentMeta(entry, "a1")).toMatchObject({
			agent: "task",
			task: "t",
			parentToolCallId: "t1",
		});
		handleSubagentLifecycle(entry, lifecycle("started"));
		expect(finishedSubagentMeta(entry, "a1")).toBeUndefined();
	});

	test("clearing the session drops retained metadata", () => {
		const entry = entryStub();
		handleSubagentLifecycle(entry, lifecycle("started"));
		handleSubagentLifecycle(entry, lifecycle("completed"));
		clearSubagents(entry);
		expect(finishedSubagentMeta(entry, "a1")).toBeUndefined();
	});
});
