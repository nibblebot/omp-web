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
