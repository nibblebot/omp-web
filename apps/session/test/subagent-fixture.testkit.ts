/**
 * Fixture session directory shared by the subagent roster and image tests: a root session file with
 * its `<root>/` artifact tree of finished subagent transcripts, as a stopped and resumed session leaves them.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { SessionEntry } from "../session-entry";

const TS = "2026-01-01T00:00:00.000Z";

export interface FixtureAgent {
	id: string;
	/** Agent definition recorded in the transcript's `session_init`. */
	agent: string;
	task: string;
	/** Extra JSONL records appended after the first user message. */
	extra?: unknown[];
}

export interface FixtureSession {
	dir: string;
	root: string;
	/** Transcript path of each agent, keyed by id. */
	files: Map<string, string>;
}

export function jsonl(records: readonly unknown[]): string {
	return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

export function messageRecord(id: string, parentId: string | null, message: unknown): unknown {
	return { type: "message", id, parentId, timestamp: TS, message };
}

/** A finished subagent transcript: header, `session_init`, the assignment, an answer, then `extra`. */
export function agentTranscript(agent: FixtureAgent): string {
	return jsonl([
		{ type: "session", version: 3, id: `${agent.id}-sid`, timestamp: TS, cwd: "/work" },
		{
			type: "session_init",
			id: "init",
			parentId: null,
			timestamp: TS,
			systemPrompt: ["role"],
			task: agent.task,
			tools: ["read"],
			agent: agent.agent,
		},
		messageRecord("u1", "init", { role: "user", content: [{ type: "text", text: agent.task }] }),
		messageRecord("a1", "u1", { role: "assistant", content: [{ type: "text", text: "done" }] }),
		...(agent.extra ?? []),
	]);
}

/**
 * `<dir>/root.jsonl` (the parent session, `parentRecords` after its header) plus `<dir>/root/<id>.jsonl`
 * for each agent. Nothing is registered anywhere: this is the on-disk state after a process restart.
 */
export function writeFixtureSession(
	dir: string,
	agents: readonly FixtureAgent[],
	parentRecords: readonly unknown[] = [],
): FixtureSession {
	const root = join(dir, "root.jsonl");
	mkdirSync(join(dir, "root"), { recursive: true });
	writeFileSync(
		root,
		jsonl([
			{ type: "session", version: 3, id: "root-sid", timestamp: TS, cwd: "/work" },
			...parentRecords,
		]),
	);
	const files = new Map<string, string>();
	for (const agent of agents) {
		const file = join(dir, "root", `${agent.id}.jsonl`);
		writeFileSync(file, agentTranscript(agent));
		files.set(agent.id, file);
	}
	return { dir, root, files };
}

/** A resumed session's entry: a fresh private registry and an empty lifecycle mirror. */
export function resumedEntry(root: string): SessionEntry {
	const entry = {
		session: {
			sessionFile: root,
			sessionManager: { getSessionId: () => "root-session" },
		},
		agentRegistry: new AgentRegistry(),
		subagentSnapshots: new Map(),
		transcriptSessionFilesBySubagentId: new Map<string, string>(),
	};
	// Test double: the roster, transcript and image paths read only the members above.
	return entry as unknown as SessionEntry;
}
