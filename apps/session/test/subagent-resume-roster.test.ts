/**
 * bax2: after the session process stops and resumes, the finished subagents exist only on disk
 * (`<session dir>/<id>.jsonl`). Their transcripts must still open, and their roster rows must keep
 * the agent type, description and assignment that durable data (the transcript's `session_init`,
 * the parent's Task result) still has.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { createWebMethods } from "../methods";
import { listWorkers } from "../worker-lifecycle";
import {
	messageRecord,
	resumedEntry,
	writeFixtureSession,
	type FixtureSession,
} from "./subagent-fixture.testkit";

afterAll(cleanupTempDirs);

const TASK_CALL = "toolu_task_1";

/** The parent's Task call and result as the SDK persists them: `details.progress` while spawned, `details.results` once settled. */
function parentTaskRecords(): unknown[] {
	return [
		messageRecord("p1", null, {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: TASK_CALL,
					name: "task",
					arguments: {
						context: "ctx",
						tasks: [{ name: "SleepyReader", task: "read", solutionSpace: "x" }],
					},
				},
			],
		}),
		messageRecord("p2", "p1", {
			role: "toolResult",
			toolCallId: TASK_CALL,
			toolName: "task",
			content: [{ type: "text", text: "Spawned 2 background agents" }],
			details: {
				results: [
					{
						index: 1,
						id: "QuickGrep",
						agent: "scout",
						agentSource: "bundled",
						task: "Complete assignment:\n# Target\nGrep for usages",
						assignment: "# Target\nGrep for usages",
						description: "Grep usages",
					},
				],
				progress: [
					{
						index: 0,
						id: "SleepyReader",
						agent: "explore",
						agentSource: "bundled",
						status: "pending",
						task: "Complete assignment:\n# Target\nRead the docs",
						assignment: "# Target\nRead the docs",
					},
				],
			},
		}),
	];
}

function fixture(): FixtureSession {
	return writeFixtureSession(
		tempDir("omp-web-resume-roster-"),
		[
			{
				id: "SleepyReader",
				agent: "explore",
				task: "Complete assignment:\n# Target\nRead the docs",
			},
			{ id: "QuickGrep", agent: "scout", task: "Complete assignment:\n# Target\nGrep for usages" },
		],
		parentTaskRecords(),
	);
}

function methods() {
	return createWebMethods({
		settings: {} as never,
		authStorage: {} as never,
		collab: {} as never,
		broker: {} as never,
		materializeSession: async () => ({ alreadyPresent: true as const }),
		sessionsDir: "/tmp/fleet-test-sessions",
		cwd: "/tmp/fleet-test-cwd",
		hasCallbackPair: () => false,
	}).methods;
}

describe("parked subagent transcripts after a resume", () => {
	test("every worker the roster lists opens its transcript", async () => {
		const { root, files } = fixture();
		const entry = resumedEntry(root);
		const listed = await listWorkers(entry);
		expect(listed.map((row) => row.id).sort()).toEqual(["QuickGrep", "SleepyReader"]);
		for (const row of listed) expect(row.status).toBe("parked");
		for (const [id, file] of files) {
			const page = (await methods().getSubagentMessages!(entry, [{ subagentId: id }])) as {
				sessionFile: string;
				messages: Array<{ role: string }>;
			};
			expect(page.sessionFile).toBe(file);
			expect(page.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		}
	});

	test("a fresh read needs no prior roster listing", async () => {
		const { root } = fixture();
		const page = (await methods().getSubagentMessages!(resumedEntry(root), [
			{ subagentId: "QuickGrep" },
		])) as { messages: unknown[] };
		expect(page.messages).toHaveLength(2);
	});

	test("ids and files the roster does not list stay unreadable", async () => {
		const { root, dir } = fixture();
		const entry = resumedEntry(root);
		const outside = tempDir("omp-web-resume-outside-");
		const { files: foreign } = writeFixtureSession(outside, [
			{ id: "Intruder", agent: "task", task: "x" },
		]);
		const foreignFile = foreign.get("Intruder")!;
		entry.agentRegistry.register({
			id: "Intruder",
			displayName: "task",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile: foreignFile,
			status: "parked",
		});
		const read = (selector: object) => methods().getSubagentMessages!(entry, [selector]);
		await expect(read({ subagentId: "Intruder" })).rejects.toThrow("Unknown subagent");
		await expect(read({ subagentId: "Nobody" })).rejects.toThrow("Unknown subagent");
		await expect(read({ subagentId: "../root" })).rejects.toThrow("Unknown subagent");
		await expect(read({ sessionFile: foreignFile })).rejects.toThrow(
			"Unknown subagent session file",
		);
		await expect(read({ sessionFile: `${dir}/root/Missing.jsonl` })).rejects.toThrow(
			"Unknown subagent session file",
		);
	});

	test("the roster row keeps agent type, description and assignment from durable data", async () => {
		const { root } = fixture();
		const rows = new Map((await listWorkers(resumedEntry(root))).map((row) => [row.id, row]));
		expect(rows.get("SleepyReader")).toMatchObject({
			displayName: "explore",
			parentToolCallId: TASK_CALL,
			assignment: "# Target\nRead the docs",
			task: "Complete assignment:\n# Target\nRead the docs",
		});
		expect(rows.get("SleepyReader")?.description).toBeUndefined();
		expect(rows.get("QuickGrep")).toMatchObject({
			displayName: "scout",
			parentToolCallId: TASK_CALL,
			description: "Grep usages",
			assignment: "# Target\nGrep for usages",
		});
	});

	test("a worker with no durable task record shows its agent type, never invented text", async () => {
		const dir = tempDir("omp-web-resume-bare-");
		const { root } = writeFixtureSession(dir, [{ id: "Lonely", agent: "reviewer", task: "t" }]);
		const [row] = await listWorkers(resumedEntry(root));
		expect(row).toMatchObject({ id: "Lonely", displayName: "reviewer" });
		expect(row.description).toBeUndefined();
		expect(row.assignment).toBeUndefined();
		expect(row.parentToolCallId).toBeUndefined();
	});
});
