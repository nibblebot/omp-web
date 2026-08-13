import { stat } from "node:fs/promises";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { FileEntry, SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { parseSessionEntries } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import type {
	AgentProgress,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "@oh-my-pi/pi-coding-agent/task";
import type { SubagentMessagesResult } from "../shared/protocol";
import type { SessionEntry } from "./session-entry";
import { broadcastTo } from "./sse-delivery";

// ---------------------------------------------------------------------------
// Subagent mirror: a port of the RPC mode's subagent registry semantics at a
// fixed "progress" subscription level (subagent_event frames were never
// emitted at that level, so the raw event channel is not relayed). Lifecycle
// and progress payloads are broadcast verbatim — the client parses exactly
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
	payload: Pick<SubagentLifecyclePayload | SubagentProgressPayload, "parentToolCallId" | "sessionFile">,
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

function rememberTranscriptSession(entry: SessionEntry, subagentId: string, sessionFile: string | undefined): void {
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
	for (const subagentId of entry.subagentSnapshots.keys()) {
		addPruned(entry.staleSubagentIds, subagentId, MAX_RETAINED_TRANSCRIPT_REFERENCES);
	}
	for (const subagentId of entry.transcriptSessionFilesBySubagentId.keys()) {
		addPruned(entry.staleSubagentIds, subagentId, MAX_RETAINED_TRANSCRIPT_REFERENCES);
	}
	entry.subagentSnapshots.clear();
	entry.transcriptSessionFilesBySubagentId.clear();
	entry.onSubagentsChange?.();
}

// Payloads are JSON-safe snapshots; drop a frame rather than kill the relay
// if one ever isn't serializable.
function broadcastSubagentFrame(entry: SessionEntry, type: "subagent_lifecycle" | "subagent_progress", payload: unknown): void {
	try {
		broadcastTo(entry.handle, { type, payload });
	} catch (err) {
		console.error(`Dropping unserializable ${type} frame:`, err);
	}
}

export function handleSubagentLifecycle(entry: SessionEntry, payload: SubagentLifecyclePayload): void {
	const existing = entry.subagentSnapshots.get(payload.id);
	if (existing && !hasSameOwner(payload, existing)) return;
	if (!existing && payload.status !== "started") return;
	if (payload.status === "started") {
		entry.staleSubagentIds.delete(payload.id);
	}
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

export function handleSubagentProgress(entry: SessionEntry, payload: SubagentProgressPayload): void {
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
	broadcastSubagentFrame(entry, "subagent_progress", payload);
}

export function resolveSubagentSessionFile(entry: SessionEntry, selector: { subagentId?: string; sessionFile?: string }): string {
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

/** Port of the RPC transcript reader: byte-offset paging over the subagent's .jsonl. */
export async function readSubagentTranscript(sessionFile: string, fromByte = 0): Promise<SubagentMessagesResult> {
	let startByte = Number.isFinite(fromByte) ? Math.max(0, Math.trunc(fromByte)) : 0;
	const file = Bun.file(sessionFile);
	let size: number;
	try {
		({ size } = await stat(sessionFile));
	} catch (err) {
		if (!isEnoent(err)) throw err;
		return { sessionFile, fromByte: startByte, nextByte: startByte, reset: false, entries: [], messages: [] };
	}
	let reset = false;
	if (startByte > size) {
		startByte = 0;
		reset = true;
	}
	const text = startByte >= size ? "" : await file.slice(startByte).text();
	const lastNewline = text.lastIndexOf("\n");
	const completeText = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : "";
	const entries = completeText.length > 0 ? parseSessionEntries(completeText) : [];
	const nextByte = startByte + Buffer.byteLength(completeText, "utf8");
	return {
		sessionFile,
		fromByte: startByte,
		nextByte,
		reset,
		entries,
		messages: entries.filter(isSessionMessageEntry).map(entry => entry.message),
	};
}
