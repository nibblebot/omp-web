/**
 * A finished worker's roster row keeps its real usage and a real elapsed span: from the usage the mirror
 * retained at finish, and after a resume from the usage summed over its transcript. Never a zeroed sample.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { handleSubagentLifecycle, handleSubagentProgress } from "../subagent-mirror";
import { listWorkers } from "../worker-lifecycle";
import { messageRecord, resumedEntry, writeFixtureSession } from "./subagent-fixture.testkit";

afterAll(cleanupTempDirs);

type LifecyclePayload = Parameters<typeof handleSubagentLifecycle>[1];
type ProgressPayload = Parameters<typeof handleSubagentProgress>[1];

const ID = "ImageReader";

function assistantTurn(id: string, parentId: string, input: number, output: number, cost: number) {
	return messageRecord(id, parentId, {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		usage: { input, output, cacheWrite: 0, totalTokens: input + output, cost: { total: cost } },
	});
}

function fixture() {
	return writeFixtureSession(tempDir("omp-web-finished-usage-"), [
		{
			id: ID,
			agent: "task",
			task: "read images",
			extra: [
				assistantTurn("a2", "a1", 60_000, 1_000, 0.15),
				assistantTurn("a3", "a2", 10_000, 954, 0.0469),
			],
		},
	]);
}

function lifecycle(status: string, sessionFile: string): LifecyclePayload {
	return {
		id: ID,
		index: 0,
		agent: "task",
		status,
		parentToolCallId: "t1",
		sessionFile,
	} as LifecyclePayload;
}

function progress(
	sessionFile: string,
	fields: Partial<ProgressPayload["progress"]>,
): ProgressPayload {
	return {
		index: 0,
		agent: "task",
		agentSource: "bundled",
		task: "t",
		parentToolCallId: "t1",
		sessionFile,
		progress: { id: ID, recentTools: [], ...fields },
	} as ProgressPayload;
}

describe("finished worker roster usage", () => {
	test("a worker that finished in this process keeps the usage it last reported", async () => {
		const { root, files } = fixture();
		const file = files.get(ID)!;
		const entry = resumedEntry(root);
		Object.assign(entry, { staleSubagentIds: new Set<string>(), handle: {} });
		handleSubagentLifecycle(entry, lifecycle("started", file));
		// The sample the first roster read after a spawn sees: nothing used yet.
		handleSubagentProgress(
			entry,
			progress(file, { status: "running", tokens: 0, requests: 0, cost: 0, durationMs: 45 }),
		);
		const [running] = await listWorkers(entry);
		expect(running.progress).toMatchObject({ tokens: 0, durationMs: 45 });
		handleSubagentProgress(
			entry,
			progress(file, {
				status: "running",
				tokens: 71_954,
				requests: 4,
				cost: 0.1969,
				durationMs: 118_000,
			}),
		);
		handleSubagentLifecycle(entry, lifecycle("completed", file));
		const [row] = await listWorkers(entry);
		expect(row.progress).toBeUndefined();
		expect(row.usage).toEqual({ tokens: 71_954, requests: 4, cost: 0.1969 });
		expect(row.lastActivity).toBeGreaterThan(row.createdAt);
	});

	test("after a resume the usage is summed from the transcript, not zero or unknown", async () => {
		const { root } = fixture();
		const [row] = await listWorkers(resumedEntry(root));
		expect(row.status).toBe("parked");
		expect(row.progress).toBeUndefined();
		expect(row.usage).toEqual({ tokens: 71_954, requests: 3, cost: 0.1969 });
		expect(row.lastActivity).toBeGreaterThan(row.createdAt);
	});
});
