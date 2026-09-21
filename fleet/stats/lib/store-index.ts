/**
 * Fleet log-store coverage for /ctl/stats (P8.6). Everything here is a pure
 * disk read over FleetLogStore: never a daemon, the SDK, or compute.
 *
 * Rows joined by STABLE SESSION IDENTITY (the store sessionId ↔ a
 * fleet-local session header id). Main-streamed sessions that survive on
 * disk are counted once; the local row carries the `stored` annotation
 * rather than duplicating. Store-only sessions (deleted/stopped workspaces,
 * compute absent) surface as origin "fleet-store" rows whose `file` is a
 * display key only; their bytes are served by /ctl/stored, never by
 * /ctl/stats. Unstreamed remote history is simply absent: no row, no
 * completeness claim.
 *
 * Layering: imports only ./log-store, ../stats/*, shared/stats-types.ts,
 * node builtins. Never server/ or src/.
 */
import type { FleetLogStore, StoredSessionInfo } from "../../log-store";
import type { RawEntry } from "../../../shared/stats-types";
import { parseLine } from "./jsonl";

/** One stored main file's head facts, read from the stored bytes. */
export interface StoredHead {
	title: string | null;
	cwd: string | null;
	id: string | null;
	firstTs: number | null;
	lastTs: number | null;
	bytes: number;
}

/** Read the stored main file's head (title slot + session header + firstTs). */
export function readStoredHead(
	store: FleetLogStore,
	wsId: string,
	sessionId: string,
	relpath: string,
): StoredHead | null {
	const bytes = store.readStored(wsId, sessionId, relpath);
	if (bytes === null) return null;
	let text: string;
	try {
		text = bytes.subarray(0, Math.min(bytes.length, 64 * 1024)).toString("utf8");
	} catch {
		return null;
	}
	const lines = text.split("\n").slice(0, 4);
	const entries: RawEntry[] = [];
	for (const line of lines) {
		const e = parseLine(line);
		if (e) entries.push(e);
	}
	const first = entries[0];
	const second = entries[1];
	const head = first?.type === "session" ? first : second?.type === "session" ? second : undefined;
	const title =
		first?.type === "title" && typeof first.title === "string"
			? first.title
			: head && typeof head.title === "string"
				? head.title
				: null;
	const cwd = head && typeof head.cwd === "string" ? head.cwd : null;
	const id = head && typeof head.id === "string" ? head.id : null;
	let firstTs: number | null = null;
	let lastTs: number | null = null;
	for (const e of entries) {
		if (typeof e.timestamp === "number") {
			if (firstTs === null) firstTs = e.timestamp;
			lastTs = e.timestamp;
		}
	}
	return { title, cwd, id, firstTs, lastTs, bytes: bytes.length };
}

/** Count of stored main files per session kind, aggregated across a store. */
export function storeCoverage(
	store: FleetLogStore | null,
): { workspaces: number; sessions: number; bytes: number } | null {
	if (store === null) return null;
	let workspaces = 0;
	let sessions = 0;
	let bytes = 0;
	for (const ws of store.listStoredWorkspaces()) {
		workspaces += 1;
		for (const s of ws.sessions) {
			sessions += 1;
			bytes += s.bytes;
		}
	}
	return { workspaces, sessions, bytes };
}

/** File key for a store-only summary row (display only, never a stats :file). */
export function storeFileKey(session: StoredSessionInfo, mainRelpath: string | undefined): string {
	return mainRelpath === undefined
		? `${session.workspaceId}/${session.sessionId}`
		: `${session.workspaceId}/${session.sessionId}/${mainRelpath}`;
}
