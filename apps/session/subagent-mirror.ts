import { stat } from "node:fs/promises";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type {
	FileEntry,
	SessionMessageEntry,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { parseSessionEntries } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import type {
	AgentProgress,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "@oh-my-pi/pi-coding-agent/task";
import type {
	SubagentMessagesResult,
	SubagentProgressFields,
	SubagentUsageFields,
} from "#lib/wire/protocol";
import { createProgressCoalescer, type ProgressCoalescer } from "./subagent-progress";
import type { SessionEntry } from "./session-entry";
import { broadcastTo } from "./sse-delivery";

// ---------------------------------------------------------------------------
// Subagent mirror: a port of the RPC mode's subagent registry semantics at a
// fixed "progress" subscription level (subagent_event frames were never
// emitted at that level, so the raw event channel is not relayed). Lifecycle
// and progress payloads are broadcast verbatim; the client parses exactly
// these shapes. The mirror state lives on the owning SessionEntry (rosters
// stay namespaced per session) and owns subagentId → sessionFile resolution
// for transcript reads, including finished agents.
// ---------------------------------------------------------------------------

export interface SubagentSnapshot {
	id: string;
	index: number;
	agent: string;
	description?: string;
	status: AgentProgress["status"];
	task?: string;
	assignment?: string;
	sessionFile?: string;
	parentToolCallId?: string;
	lastUpdate: number;
	progress?: AgentProgress;
}

const MAX_RETAINED_TRANSCRIPT_REFERENCES = 256;

function isSessionMessageEntry(entry: FileEntry): entry is SessionMessageEntry {
	return entry.type === "message";
}

function statusFromLifecycle(status: SubagentLifecyclePayload["status"]): AgentProgress["status"] {
	return status === "started" ? "running" : status;
}

function hasSameOwner(
	payload: Pick<
		SubagentLifecyclePayload | SubagentProgressPayload,
		"parentToolCallId" | "sessionFile"
	>,
	snapshot: SubagentSnapshot,
): boolean {
	if (payload.parentToolCallId !== undefined && snapshot.parentToolCallId !== undefined) {
		return payload.parentToolCallId === snapshot.parentToolCallId;
	}
	if (payload.sessionFile !== undefined && snapshot.sessionFile !== undefined) {
		return payload.sessionFile === snapshot.sessionFile;
	}
	return true;
}

function addPruned(set: Set<string>, value: string, maxSize: number): void {
	set.delete(value);
	set.add(value);
	while (set.size > maxSize) {
		const oldest = set.keys().next();
		if (oldest.done) break;
		set.delete(oldest.value);
	}
}

function rememberTranscriptSession(
	entry: SessionEntry,
	subagentId: string,
	sessionFile: string | undefined,
): void {
	if (!sessionFile) return;
	entry.transcriptSessionFilesBySubagentId.delete(subagentId);
	entry.transcriptSessionFilesBySubagentId.set(subagentId, sessionFile);
	while (entry.transcriptSessionFilesBySubagentId.size > MAX_RETAINED_TRANSCRIPT_REFERENCES) {
		const oldest = entry.transcriptSessionFilesBySubagentId.keys().next();
		if (oldest.done) break;
		entry.transcriptSessionFilesBySubagentId.delete(oldest.value);
	}
}

function hasTranscriptSessionFile(entry: SessionEntry, sessionFile: string): boolean {
	for (const snapshot of entry.subagentSnapshots.values()) {
		if (snapshot.sessionFile === sessionFile) return true;
	}
	for (const transcriptSessionFile of entry.transcriptSessionFilesBySubagentId.values()) {
		if (transcriptSessionFile === sessionFile) return true;
	}
	return false;
}

/** Session change drops every tracked subagent; late frames from the old session are stale. */
export function clearSubagents(entry: SessionEntry): void {
	finishedUsage.get(entry)?.clear();
	finishedMeta.get(entry)?.clear();
	for (const subagentId of entry.subagentSnapshots.keys()) {
		addPruned(entry.staleSubagentIds, subagentId, MAX_RETAINED_TRANSCRIPT_REFERENCES);
	}
	for (const subagentId of entry.transcriptSessionFilesBySubagentId.keys()) {
		addPruned(entry.staleSubagentIds, subagentId, MAX_RETAINED_TRANSCRIPT_REFERENCES);
	}
	entry.subagentSnapshots.clear();
	entry.transcriptSessionFilesBySubagentId.clear();
	progressOf(entry).dropAll();
	entry.onSubagentsChange?.();
}

// Payloads are JSON-safe snapshots; drop a frame rather than kill the relay
// if one ever isn't serializable.
function broadcastSubagentFrame(
	entry: SessionEntry,
	type: "subagent_lifecycle" | "subagent_progress",
	payload: unknown,
): void {
	try {
		broadcastTo(entry.handle, { type, payload });
	} catch (err) {
		console.error(`Dropping unserializable ${type} frame:`, err);
	}
}

export function handleSubagentLifecycle(
	entry: SessionEntry,
	payload: SubagentLifecyclePayload,
): void {
	const existing = entry.subagentSnapshots.get(payload.id);
	if (existing && !hasSameOwner(payload, existing)) return;
	if (!existing && payload.status !== "started") return;
	if (payload.status === "started") {
		entry.staleSubagentIds.delete(payload.id);
		finishedUsage.get(entry)?.delete(payload.id);
		finishedMeta.get(entry)?.delete(payload.id);
	} else {
		progressOf(entry).flush(payload.id);
		retainFinishedUsage(entry, payload.id, existing?.progress);
		retainFinishedMeta(entry, payload.id, existing, payload);
	}
	progressOf(entry).drop(payload.id);
	const sessionFile = payload.sessionFile ?? existing?.sessionFile;
	const snapshot: SubagentSnapshot = {
		id: payload.id,
		index: payload.index,
		agent: payload.agent,
		description: payload.description ?? existing?.description,
		status: statusFromLifecycle(payload.status),
		task: existing?.task,
		assignment: existing?.assignment,
		sessionFile,
		parentToolCallId: payload.parentToolCallId ?? existing?.parentToolCallId,
		lastUpdate: Date.now(),
		progress: existing?.progress,
	};
	rememberTranscriptSession(entry, payload.id, sessionFile);
	if (payload.status === "started") {
		entry.subagentSnapshots.set(payload.id, snapshot);
	} else {
		entry.subagentSnapshots.delete(payload.id);
	}
	broadcastSubagentFrame(entry, "subagent_lifecycle", payload);
	// Collab guests mirror the same roster; notify the tap after the mutation.
	entry.onSubagentsChange?.();
}

export function handleSubagentProgress(
	entry: SessionEntry,
	payload: SubagentProgressPayload,
): void {
	const progress = payload.progress;
	if (entry.staleSubagentIds.has(progress.id)) return;
	const existing = entry.subagentSnapshots.get(progress.id);
	if (!existing) return;
	if (!hasSameOwner(payload, existing)) return;
	const sessionFile = payload.sessionFile ?? existing.sessionFile;
	rememberTranscriptSession(entry, progress.id, sessionFile);
	entry.subagentSnapshots.set(progress.id, {
		id: progress.id,
		index: payload.index,
		agent: payload.agent,
		description: progress.description ?? existing.description,
		status: progress.status,
		task: payload.task,
		assignment: payload.assignment,
		sessionFile,
		lastUpdate: Date.now(),
		parentToolCallId: payload.parentToolCallId ?? existing.parentToolCallId,
		progress,
	});
	progressOf(entry).offer(payload);
}

const coalescers = new WeakMap<SessionEntry, ProgressCoalescer>();

/** Last known usage of each finished subagent. Lifecycle drops the snapshot that carries it, so the roster reads it here. */
const finishedUsage = new WeakMap<SessionEntry, Map<string, SubagentUsageFields>>();

function retainFinishedUsage(
	entry: SessionEntry,
	id: string,
	progress: SubagentProgressFields | undefined,
): void {
	// A lifecycle frame without progress (park, revive) must not erase the usage a finish retained.
	if (progress?.tokens === undefined) return;
	let usage = finishedUsage.get(entry);
	if (usage === undefined) {
		usage = new Map();
		finishedUsage.set(entry, usage);
	}
	usage.delete(id);
	usage.set(id, {
		tokens: progress.tokens,
		requests: progress.requests ?? 0,
		cost: progress.cost ?? 0,
	});
	while (usage.size > MAX_RETAINED_TRANSCRIPT_REFERENCES) {
		const oldest = usage.keys().next().value;
		if (oldest === undefined) break;
		usage.delete(oldest);
	}
}

/** Final usage of a finished subagent; undefined when the agent is live or its usage was never reported. */
export function finishedSubagentUsage(
	entry: SessionEntry,
	id: string,
): SubagentUsageFields | undefined {
	return finishedUsage.get(entry)?.get(id);
}

/** Task metadata of each finished subagent (the lifecycle terminal frame drops the snapshot), so the roster still ties a row to the Task call that spawned it after a reload. */
export type FinishedSubagentMeta = Pick<
	SubagentSnapshot,
	"agent" | "description" | "task" | "assignment" | "parentToolCallId" | "sessionFile"
>;
const finishedMeta = new WeakMap<SessionEntry, Map<string, FinishedSubagentMeta>>();

function retainFinishedMeta(
	entry: SessionEntry,
	id: string,
	existing: SubagentSnapshot | undefined,
	payload: SubagentLifecyclePayload,
): void {
	let metas = finishedMeta.get(entry);
	if (metas === undefined) {
		metas = new Map();
		finishedMeta.set(entry, metas);
	}
	const prior = metas.get(id);
	metas.delete(id);
	metas.set(id, {
		agent: payload.agent,
		description: payload.description ?? existing?.description ?? prior?.description,
		task: existing?.task ?? prior?.task,
		assignment: existing?.assignment ?? prior?.assignment,
		parentToolCallId:
			payload.parentToolCallId ?? existing?.parentToolCallId ?? prior?.parentToolCallId,
		sessionFile: payload.sessionFile ?? existing?.sessionFile ?? prior?.sessionFile,
	});
	while (metas.size > MAX_RETAINED_TRANSCRIPT_REFERENCES) {
		const oldest = metas.keys().next().value;
		if (oldest === undefined) break;
		metas.delete(oldest);
	}
}

/** Task metadata of a finished subagent; undefined while the agent is live or was never seen finishing. */
export function finishedSubagentMeta(
	entry: SessionEntry,
	id: string,
): FinishedSubagentMeta | undefined {
	return finishedMeta.get(entry)?.get(id);
}

/** The entry's progress coalescer; its frames are broadcast on the entry's session handle. */
function progressOf(entry: SessionEntry): ProgressCoalescer {
	let coalescer = coalescers.get(entry);
	if (coalescer === undefined) {
		coalescer = createProgressCoalescer({
			emit: (frame) => broadcastSubagentFrame(entry, "subagent_progress", frame),
		});
		coalescers.set(entry, coalescer);
	}
	return coalescer;
}

export function resolveSubagentSessionFile(
	entry: SessionEntry,
	selector: { subagentId?: string; sessionFile?: string },
): string {
	if (selector.subagentId) {
		const sessionFile =
			entry.subagentSnapshots.get(selector.subagentId)?.sessionFile ??
			entry.transcriptSessionFilesBySubagentId.get(selector.subagentId);
		if (!sessionFile) {
			throw new Error(`Unknown subagent or session file unavailable: ${selector.subagentId}`);
		}
		return sessionFile;
	}
	if (selector.sessionFile) {
		if (hasTranscriptSessionFile(entry, selector.sessionFile)) return selector.sessionFile;
		throw new Error("Unknown subagent session file");
	}
	throw new Error("getSubagentMessages requires subagentId or sessionFile");
}

/** Read bounded complete JSONL records; entry IDs remain durable transcript anchors. */
export async function readSubagentTranscript(
	sessionFile: string,
	fromByte = 0,
	maxBytes = 256 * 1024,
): Promise<SubagentMessagesResult & { hasMore: boolean }> {
	let startByte = Number.isFinite(fromByte) ? Math.max(0, Math.trunc(fromByte)) : 0;
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 4 * 1024 * 1024) {
		throw new Error("Worker transcript page size must be between 1024 and 4194304 bytes");
	}
	const file = Bun.file(sessionFile);
	let size: number;
	try {
		({ size } = await stat(sessionFile));
	} catch (err) {
		if (!isEnoent(err)) throw err;
		throw new Error("Worker transcript artifact unavailable");
	}
	let reset = false;
	if (startByte > size) {
		startByte = 0;
		reset = true;
	}
	const endByte = Math.min(size, startByte + maxBytes);
	const bytes =
		startByte >= size
			? Buffer.alloc(0)
			: Buffer.from(await file.slice(startByte, endByte).arrayBuffer());
	const lastNewline = bytes.lastIndexOf(10);
	if (lastNewline < 0 && endByte < size) {
		throw new Error("Worker transcript record exceeds page size; request a larger bounded page");
	}
	const completeBytes = lastNewline >= 0 ? bytes.subarray(0, lastNewline + 1) : Buffer.alloc(0);
	const entries =
		completeBytes.length > 0 ? parseSessionEntries(completeBytes.toString("utf8")) : [];
	const nextByte = startByte + completeBytes.length;
	return {
		sessionFile,
		fromByte: startByte,
		nextByte,
		reset,
		hasMore: nextByte < size && endByte < size,
		entries,
		messages: entries.filter(isSessionMessageEntry).map((entry) => entry.message),
	};
}
