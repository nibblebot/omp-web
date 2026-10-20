import { open, stat } from "node:fs/promises";
import type { SessionEntry } from "./session-entry";

// ---------------------------------------------------------------------------
// Durable Task metadata. The lifecycle mirror (subagent-mirror.ts) forgets a
// subagent's agent type, description, task and assignment when the process
// stops. The parent session file keeps them: every `task` tool result persists
// `details.progress[]` / `details.results[]` rows keyed by the spawned agent's id,
// and the result's own `toolCallId` is the Task call that spawned them. This
// reads those rows back, incrementally, so a resumed session's roster is as
// descriptive as the one that ran the agents. Values the file does not carry
// stay undefined: nothing is derived or invented.
// ---------------------------------------------------------------------------

export interface PersistedTaskMeta {
	agent?: string;
	description?: string;
	task?: string;
	assignment?: string;
	parentToolCallId?: string;
}

interface FileScan {
	/** Byte after the last complete line already read. */
	offset: number;
	metas: Map<string, PersistedTaskMeta>;
}

const READ_CHUNK_BYTES = 4 * 1024 * 1024;
/** JSON.stringify never pads, so this marks every persisted `task` tool result line. */
const TASK_RESULT_MARKER = '"toolName":"task"';

const scans = new WeakMap<SessionEntry, Map<string, FileScan>>();

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function mergeRow(
	metas: Map<string, PersistedTaskMeta>,
	row: unknown,
	parentToolCallId: string | undefined,
): void {
	const record = asRecord(row);
	const id = asString(record?.id);
	if (record === undefined || id === undefined) return;
	const prior = metas.get(id);
	metas.set(id, {
		agent: asString(record.agent) ?? prior?.agent,
		description: asString(record.description) ?? prior?.description,
		task: asString(record.task) ?? prior?.task,
		assignment: asString(record.assignment) ?? prior?.assignment,
		parentToolCallId: parentToolCallId ?? prior?.parentToolCallId,
	});
}

function readLine(metas: Map<string, PersistedTaskMeta>, line: string): void {
	if (!line.includes(TASK_RESULT_MARKER)) return;
	let record: unknown;
	try {
		record = JSON.parse(line);
	} catch {
		return;
	}
	const message = asRecord(asRecord(record)?.message);
	if (message?.role !== "toolResult" || message.toolName !== "task") return;
	const details = asRecord(message.details);
	const parentToolCallId = asString(message.toolCallId);
	// Progress rows first: a settled result row of the same id carries the final values.
	for (const rows of [details?.progress, details?.results]) {
		if (Array.isArray(rows)) for (const row of rows) mergeRow(metas, row, parentToolCallId);
	}
}

/**
 * Task metadata of the agents spawned by the Task calls recorded in `sessionFile`, by agent id. The
 * caller owns the jail check: only a file inside the session's own artifact tree may be passed.
 * Reads only the bytes appended since the previous call.
 */
export async function persistedTaskMeta(
	entry: SessionEntry,
	sessionFile: string,
): Promise<ReadonlyMap<string, PersistedTaskMeta>> {
	let files = scans.get(entry);
	if (files === undefined) {
		files = new Map();
		scans.set(entry, files);
	}
	let scan = files.get(sessionFile);
	if (scan === undefined) {
		scan = { offset: 0, metas: new Map() };
		files.set(sessionFile, scan);
	}
	let size: number;
	try {
		({ size } = await stat(sessionFile));
	} catch {
		return scan.metas;
	}
	if (size < scan.offset) scan = { offset: 0, metas: new Map() };
	files.set(sessionFile, scan);
	if (size === scan.offset) return scan.metas;
	const handle = await open(sessionFile, "r");
	try {
		let pending = Buffer.alloc(0);
		let position = scan.offset;
		while (position < size) {
			const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, size - position));
			const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
			if (bytesRead === 0) break;
			position += bytesRead;
			pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
			const lastNewline = pending.lastIndexOf(10);
			if (lastNewline < 0) continue;
			for (const line of pending.subarray(0, lastNewline).toString("utf8").split("\n")) {
				readLine(scan.metas, line);
			}
			scan.offset += lastNewline + 1;
			pending = pending.subarray(lastNewline + 1);
		}
	} finally {
		await handle.close();
	}
	return scan.metas;
}
