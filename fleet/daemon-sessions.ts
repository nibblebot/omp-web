/**
 * Fleet-side session listing for the roster dropdown: the last N sessions of
 * a daemon's worktree, newest-first.
 *
 * The listing goes through the SDK's own SessionManager (LAZY dynamic import
 * — same "fleet stays SDK-free at static-import time" rule as
 * fleet/omp-check.ts) so the per-cwd session-dir derivation, HOME/TMP
 * encoding, legacy-dir migration, and scan caching are the SDK's canonical
 * implementation rather than a second convention.
 *
 * Agent-dir resolution: `agentDir` is an OPTIONAL test seam. Production never
 * passes it, so the SDK derives the dir from the fleet process env
 * (`PI_CODING_AGENT_DIR` or the platform default) — which matches production
 * spawns, since the DEFAULT_LOCAL_TEMPLATE spawns daemons inheriting the
 * fleet's environment. Dev/test templates that override the agent dir per
 * daemon are out of scope here.
 */

import type { SessionListEntry } from "../shared/protocol";

/**
 * Fleet transcript store read surface (P3.8) — the clone counterpart of the
 * SDK SessionManager listing. The edge injects the fleet's FleetLogStore via
 * this STRUCTURAL subset so this module never imports the fleet log-store
 * implementation (it stays a fleet/transport-boundary leaf). FleetLogStore's
 * `listStoredSessions(workspaceId)` satisfies it exactly.
 */
export interface CloneSessionStore {
	listStoredSessions(workspaceId: string): StoredSessionInfo[];
}

/** Read-only per-session store row (structural subset of log-store's StoredSessionInfo). */
export interface StoredSessionInfo {
	workspaceId: string;
	sessionId: string;
	/** Main-session relpath when one exists (`<sessionId>.jsonl` or `<proj>/<sessionId>.jsonl`). */
	mainRelpath?: string;
	/** Total durable bytes across stored files. */
	bytes: number;
	/** Latest file mtime under the session subtree, or 0. */
	mtimeMs: number;
}

/**
 * The last `limit` fleet-stored sessions of one clone workspace, newest-
 * modified first. The store key IS the SDK session id (slash-free lineage
 * key), so identity compares directly against resume/attach inputs — never a
 * fleet-local cwd/filesystem assumption (P8.4). The store index carries no
 * prompt text, so labels fall back to the timestamp form (StoredHistory's
 * display rows enrich titles from JSONL heads for its own read surface).
 * Never throws: a missing store or workspace returns an empty list so the
 * roster dropdown degrades to "no sessions".
 */
export async function listCloneDaemonSessions(
	store: CloneSessionStore | undefined,
	workspaceId: string,
	limit = 10,
): Promise<SessionListEntry[]> {
	if (store === undefined) return [];
	try {
		const stored = store.listStoredSessions(workspaceId);
		return stored
			.map((s): SessionListEntry => {
				const name = sessionDisplayName({
					title: undefined,
					firstMessage: "(no messages)",
					created: new Date(s.mtimeMs),
					modified: new Date(s.mtimeMs),
				});
				return {
					path: s.sessionId,
					id: s.sessionId,
					name,
					cwd: "",
					modifiedAt: s.mtimeMs,
					messageCount: 0,
				};
			})
			.sort((a, b) => b.modifiedAt - a.modifiedAt)
			.slice(0, limit);
	} catch {
		return [];
	}
}

/** Sanitize a display string to its first meaningful line (control chars stripped). */
function safeLine(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const first = value.split(/\r?\n/)[0] ?? "";
	const stripped = first.replace(/[\x00-\x1F\x7F]/g, "").trim();
	return stripped.length > 0 ? stripped : undefined;
}

/**
 * Friendly dropdown label: explicit title, then the first user prompt, then
 * a timestamp fallback — the raw session id is never shown (mirrors the
 * SDK's own sessionDisplayName behavior; that helper is module-private).
 */
function sessionDisplayName(info: {
	title?: string;
	firstMessage: string;
	created: Date;
	modified: Date;
}): string {
	const title = safeLine(info.title);
	if (title) return title;
	const first =
		info.firstMessage && info.firstMessage !== "(no messages)"
			? safeLine(info.firstMessage)
			: undefined;
	if (first) return first;
	const ts = Number.isFinite(info.created.getTime()) ? info.created : info.modified;
	return `Untitled · ${ts.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

/**
 * The last `limit` sessions in a cwd's session dir, newest-modified first.
 * Never throws — any failure (SDK import, unreadable dir, bad env) returns
 * an empty list so the roster dropdown degrades to "no sessions" instead of
 * erroring the whole row.
 */
export async function listDaemonSessions(
	cwd: string,
	limit = 10,
	agentDir?: string,
): Promise<SessionListEntry[]> {
	try {
		const [{ SessionManager }, { FileSessionStorage }] = await Promise.all([
			import("@oh-my-pi/pi-coding-agent/session/session-manager"),
			import("@oh-my-pi/pi-coding-agent/session/session-storage"),
		]);
		const storage = new FileSessionStorage();
		const sessionDir = SessionManager.getDefaultSessionDir(cwd, agentDir, storage);
		const infos = await SessionManager.list(cwd, sessionDir, storage);
		return infos
			.map((i): SessionListEntry => ({
				path: i.path,
				id: i.id,
				name: sessionDisplayName(i),
				cwd: i.cwd,
				messageCount: i.messageCount,
				modifiedAt: i.modified.getTime(),
			}))
			.sort((a, b) => b.modifiedAt - a.modifiedAt)
			.slice(0, limit);
	} catch {
		return [];
	}
}
