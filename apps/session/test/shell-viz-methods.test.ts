/**
 * `getShellVisualization` against traces the SDK's real bash tool produced (the embedded
 * shell's own `RunTrace`, rendered by the SDK's native presentation engine): the settled call,
 * a running call's latest partial, a subagent's transcript, replay, the explicit unavailable
 * answers, and the bound under the callback envelope.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAgentSession, Settings } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { ENVELOPE_MAX_BYTES } from "#lib/wire/callback-protocol";
import { READ_ONLY_METHODS, type ShellVizDto } from "#lib/wire/protocol";
import { toWireEvent } from "../client-delivery";
import type { SessionEntry } from "../session-entry";
import {
	createShellVizMethods,
	SHELL_VIZ_VIEW_BYTES,
	shellVizDto,
	findTraceInTranscript,
} from "../shell-viz-methods";

afterAll(cleanupTempDirs);

const previousDir = getAgentDir();
const previousEnv = process.env.PI_CODING_AGENT_DIR;
let session: AgentSession;
beforeAll(async () => {
	setAgentDir(tempDir("omp-shell-viz-agent-"));
	const cwd = tempDir("omp-shell-viz-");
	session = (
		await createAgentSession({
			cwd,
			settings: Settings.isolated(),
			sessionManager: SessionManager.inMemory(cwd),
			agentRegistry: new AgentRegistry(),
			disableExtensionDiscovery: true,
			enableLsp: false,
		})
	).session;
});
afterAll(async () => {
	await session.dispose();
	setAgentDir(previousDir);
	if (previousEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousEnv;
});

interface BashResult {
	content: Array<{ type: "text"; text: string }>;
	details?: { trace?: unknown };
}

/** The settled result of the SDK's bash tool for `command`, trace and all. */
async function runBash(toolCallId: string, command: string): Promise<BashResult> {
	const bash = session.agent.state.tools.find((tool) => tool.name === "bash");
	if (!bash) throw new Error("the session has no bash tool");
	return (await bash.execute(
		toolCallId,
		{ command },
		undefined,
		undefined,
		undefined,
	)) as BashResult;
}

const toolResult = (
	toolCallId: string,
	details: Record<string, unknown> | undefined,
	toolName = "bash",
) => ({
	role: "toolResult" as const,
	toolCallId,
	toolName,
	content: [{ type: "text" as const, text: "out" }],
	...(details === undefined ? {} : { details }),
	isError: false,
	timestamp: 0,
});

const entryWith = (messages: unknown[], handle = "shell-viz"): SessionEntry =>
	({ handle, session: { messages } }) as unknown as SessionEntry;

const resolveTranscriptFile = async (_entry: SessionEntry, selector: { subagentId: string }) => {
	const file = transcripts.get(selector.subagentId);
	if (file === undefined) throw new Error(`Unknown subagent: ${selector.subagentId}`);
	return file;
};
const transcripts = new Map<string, string>();
const methods = createShellVizMethods({ resolveTranscriptFile });
const ask = async (entry: SessionEntry, arg: Record<string, unknown>) =>
	(await methods.getShellVisualization(entry, [arg])) as ShellVizDto;

function available(answer: ShellVizDto) {
	if (!answer.available) throw new Error(`unavailable: ${answer.reason}`);
	return answer;
}

const text = (row: { segments: Array<{ text: string }> }) =>
	row.segments.map((s) => s.text).join("");

describe("getShellVisualization classification", () => {
	test("is a read-only method", () => {
		expect(READ_ONLY_METHODS.getShellVisualization).toBe(true);
	});
});

describe("settled calls", () => {
	test("echo: Pseudo and Raw rows of the command, a timeline, no output", async () => {
		const result = await runBash("echo-1", "echo hi");
		const answer = available(
			await ask(entryWith([toolResult("echo-1", result.details)]), { toolCallId: "echo-1" }),
		);
		expect(answer.running).toBe(false);
		expect(answer.status).toBe(0);
		expect(answer.pseudo.map(text).join("\n")).toContain('"hi"');
		expect(answer.raw.map(text).join("\n")).toContain("echo hi");
		expect(answer.timeline.cursor).toBe(answer.timeline.length);
		expect(answer.omittedRows).toBeUndefined();
		expect(JSON.stringify(answer)).not.toContain('"output"');
		// The DTO is ANSI-free and a small fraction of the trace.
		expect(JSON.stringify(answer)).not.toContain("\u001b");
		expect(JSON.stringify(answer).length).toBeLessThan(
			JSON.stringify(result.details?.trace).length,
		);
	});

	test("failures carry a mark, an error row note and the exit status", async () => {
		const result = await runBash("fail-1", "false; ls /nonexistent-path; echo done");
		const answer = available(
			await ask(entryWith([toolResult("fail-1", result.details)]), { toolCallId: "fail-1" }),
		);
		expect(answer.status).toBe(0);
		const failed = answer.pseudo.filter((row) => row.failed);
		expect(failed.length).toBe(2);
		expect(failed.every((row) => row.segments.some((segment) => segment.failed))).toBe(true);
		expect(failed.map((row) => row.meta)).toEqual([
			expect.stringContaining("exit 1"),
			expect.stringContaining("exit 2"),
		]);
	});

	test("variable values ride the row that set them, with tones on tokens", async () => {
		const result = await runBash("vars-1", "n=0\nfor i in 1 2 3; do n=$((n+i)); done");
		const answer = available(
			await ask(entryWith([toolResult("vars-1", result.details)]), { toolCallId: "vars-1" }),
		);
		const variables = answer.pseudo.flatMap((row) => row.variables ?? []);
		expect(variables).toContainEqual({ name: "n", value: "6" });
		expect(
			answer.pseudo.flatMap((row) => row.segments).some((segment) => segment.tone === "keyword"),
		).toBe(true);
	});

	test("replay: a cursor shows the run as of that many history records", async () => {
		const result = await runBash("replay-1", "n=0\nfor i in 1 2 3; do n=$((n+i)); done");
		const entry = entryWith([toolResult("replay-1", result.details)]);
		const full = available(await ask(entry, { toolCallId: "replay-1" }));
		const start = available(await ask(entry, { toolCallId: "replay-1", cursor: 0 }));
		expect(start.timeline).toMatchObject({ cursor: 0, length: full.timeline.length, elapsedNs: 0 });
		expect(start.pseudo.flatMap((row) => row.variables ?? [])).toEqual([]);
		const mid = available(await ask(entry, { toolCallId: "replay-1", cursor: 5 }));
		expect(mid.timeline.cursor).toBe(5);
		const past = available(await ask(entry, { toolCallId: "replay-1", cursor: 10_000 }));
		expect(past.timeline.cursor).toBe(full.timeline.length);
	});

	test("measured sizes: echo, a 50-line loop and a 2000-iteration loop", async () => {
		const sizes: Record<string, { trace: number; answer: number }> = {};
		const runs: Array<[string, string]> = [
			["echo", "echo hi"],
			["loop50", "for i in $(seq 1 50); do echo line $i; x=$((i*2)); done"],
			["loop2000", "for i in $(seq 1 2000); do echo line $i; x=$((i*2)); done"],
		];
		for (const [name, command] of runs) {
			const result = await runBash(`size-${name}`, command);
			const answer = await ask(entryWith([toolResult(`size-${name}`, result.details)]), {
				toolCallId: `size-${name}`,
			});
			available(answer);
			sizes[name] = {
				trace: JSON.stringify(result.details?.trace).length,
				answer: JSON.stringify(answer).length,
			};
			expect(sizes[name].answer).toBeLessThan(ENVELOPE_MAX_BYTES);
		}
		console.log("shell viz sizes (bytes)", JSON.stringify(sizes));
		expect(sizes.loop2000.answer).toBeLessThan(sizes.loop2000.trace / 20);
	});
});

describe("running calls", () => {
	test("the latest partial's trace answers while the call runs, and ends with the call", async () => {
		const result = await runBash("run-1", "echo one; echo two");
		const settled = result.details?.trace as { status?: number };
		// The same snapshot as the SDK reports it mid-run: no root status yet.
		const { status: _status, ...partialTrace } = settled as Record<string, unknown>;
		const handle = "shell-viz-running";
		const update = {
			type: "tool_execution_update",
			toolCallId: "run-1",
			toolName: "bash",
			args: {},
			partialResult: { content: [{ type: "text", text: "one" }], details: { trace: partialTrace } },
		} as unknown as AgentSessionEvent;
		toWireEvent(handle, update);
		const entry = entryWith([], handle);
		const live = available(await ask(entry, { toolCallId: "run-1" }));
		expect(live.running).toBe(true);
		expect(live.status).toBeUndefined();
		expect(live.pseudo.length).toBeGreaterThan(0);
		// The tool ended: the entry goes, the settled result in the transcript answers.
		toWireEvent(handle, {
			type: "tool_execution_end",
			toolCallId: "run-1",
			toolName: "bash",
			result: { content: [], details: { trace: settled } },
			isError: false,
		} as unknown as AgentSessionEvent);
		expect(await ask(entry, { toolCallId: "run-1" })).toEqual({
			available: false,
			reason: "unknown_call",
		});
		const settledAnswer = available(
			await ask(entryWith([toolResult("run-1", result.details)], handle), { toolCallId: "run-1" }),
		);
		expect(settledAnswer.running).toBe(false);
	});
});

describe("unavailable answers", () => {
	test("an unknown call id", async () => {
		expect(await ask(entryWith([]), { toolCallId: "nope" })).toEqual({
			available: false,
			reason: "unknown_call",
		});
	});

	test("a call id that names another tool's result", async () => {
		const entry = entryWith([toolResult("read-1", { trace: {} }, "read")]);
		expect(await ask(entry, { toolCallId: "read-1" })).toEqual({
			available: false,
			reason: "unknown_call",
		});
	});

	test("a bash result without a trace, or with no details at all", async () => {
		const entry = entryWith([toolResult("old-1", { exitCode: 0 }), toolResult("old-2", undefined)]);
		expect(await ask(entry, { toolCallId: "old-1" })).toEqual({
			available: false,
			reason: "no_trace",
		});
		expect(await ask(entry, { toolCallId: "old-2" })).toEqual({
			available: false,
			reason: "no_trace",
		});
	});

	test("a malformed trace is invalid, never a throw", async () => {
		const entry = entryWith([toolResult("bad-1", { trace: { v: 1, nonsense: true } })]);
		expect(await ask(entry, { toolCallId: "bad-1" })).toEqual({
			available: false,
			reason: "invalid_trace",
		});
	});

	test("a call without toolCallId is a caller error", async () => {
		await expect(methods.getShellVisualization(entryWith([]), [{}])).rejects.toThrow("toolCallId");
	});
});

describe("bounds", () => {
	test("a script of thousands of statements is cut under the envelope with an explicit marker", async () => {
		const script = Array.from(
			{ length: 4000 },
			(_, i) => `echo statement number ${i} with some padding text`,
		).join("\n");
		const result = await runBash("huge-1", script);
		const answer = available(
			await ask(entryWith([toolResult("huge-1", result.details)]), { toolCallId: "huge-1" }),
		);
		expect(answer.omittedRows).toBeDefined();
		expect(answer.omittedRows?.pseudo).toBeGreaterThan(0);
		expect(answer.pseudo.length + (answer.omittedRows?.pseudo ?? 0)).toBeGreaterThanOrEqual(4000);
		expect(Buffer.byteLength(JSON.stringify(answer), "utf8")).toBeLessThan(ENVELOPE_MAX_BYTES);
		for (const rows of [answer.pseudo, answer.raw])
			expect(Buffer.byteLength(JSON.stringify(rows), "utf8")).toBeLessThanOrEqual(
				SHELL_VIZ_VIEW_BYTES + 1024,
			);
		// The kept rows are the head of the script, in order.
		expect(text(answer.pseudo[0])).toContain('"0"');
	});

	test("a very long token is shortened", async () => {
		const result = await runBash("long-1", `echo ${"x".repeat(5000)}`);
		const trace = result.details?.trace;
		if (!(typeof trace === "object" && trace !== null)) throw new Error("no trace");
		const dto = available(shellVizDto(trace as never));
		expect(
			dto.raw.flatMap((row) => row.segments).every((segment) => segment.text.length <= 600),
		).toBe(true);
	});
});

describe("subagent transcripts", () => {
	async function transcriptWith(lines: string[]): Promise<string> {
		const directory = tempDir("omp-shell-viz-transcript-");
		await mkdir(directory, { recursive: true });
		const file = join(directory, "worker.jsonl");
		await writeFile(file, lines.join("\n") + "\n");
		return file;
	}
	const record = (id: string, message: unknown) => JSON.stringify({ type: "message", id, message });

	test("a subagent's call is found in its transcript file and answered like the main session's", async () => {
		const result = await runBash("sub-1", "echo from the subagent");
		const file = await transcriptWith([
			record("a", { role: "user", content: "go", timestamp: 0 }),
			record("b", toolResult("sub-other", { exitCode: 0 })),
			record("c", toolResult("sub-1", result.details)),
		]);
		transcripts.set("agent-1", file);
		const answer = available(
			await ask(entryWith([]), { toolCallId: "sub-1", subagentId: "agent-1" }),
		);
		expect(answer.raw.map(text).join("\n")).toContain("echo from the subagent");
		expect(await ask(entryWith([]), { toolCallId: "sub-other", subagentId: "agent-1" })).toEqual({
			available: false,
			reason: "no_trace",
		});
		expect(await ask(entryWith([]), { toolCallId: "missing", subagentId: "agent-1" })).toEqual({
			available: false,
			reason: "unknown_call",
		});
	});

	test("an unknown subagent is an unavailable answer, not an error", async () => {
		expect(await ask(entryWith([]), { toolCallId: "x", subagentId: "ghost" })).toEqual({
			available: false,
			reason: "unknown_call",
		});
	});

	test("the scan survives records split across stream chunks and a huge unrelated line", async () => {
		const file = await transcriptWith([
			record("a", {
				role: "assistant",
				content: [{ type: "text", text: "y".repeat(3 * 1024 * 1024) }],
			}),
			record("b", toolResult("sub-2", { trace: { marker: "é".repeat(100_000) } })),
		]);
		const found = await findTraceInTranscript(file, "sub-2");
		expect(found.found).toBe(true);
		expect(JSON.stringify(found.trace)).toContain("é".repeat(100_000));
	});
});
