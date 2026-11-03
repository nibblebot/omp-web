import type { SessionStatus as ProcessStatus, SessionListEntry } from "#lib/wire/protocol";
import { displayTitle } from "../components/ui/title-icons";

// ---------------------------------------------------------------------------
// Pure session-list logic shared by the resume picker, the fleet sidebar's
// worktree session lists and (later) Analysis: row shape, Pinned / Today /
// Earlier grouping, title fallbacks, search matching and the client-side
// delete guard. No store state is read here; callers pass `now` and context
// explicitly so everything is deterministic.
// ---------------------------------------------------------------------------

/** Outcome of a stored session, as the session process reports it; anything else is `unknown`. */
export type SessionStatus =
	| "complete"
	| "interrupted"
	| "aborted"
	| "error"
	| "pending"
	| "unknown";

const KNOWN_STATUS: Record<SessionStatus, true> = {
	complete: true,
	interrupted: true,
	aborted: true,
	error: true,
	pending: true,
	unknown: true,
};

/** Narrow an untrusted status string; unrecognized values yield `undefined`. */
export function sessionStatus(value: unknown): SessionStatus | undefined {
	if (typeof value !== "string" || !Object.hasOwn(KNOWN_STATUS, value)) return undefined;
	return value as SessionStatus;
}

const STATUS_LABELS: Record<SessionStatus, string> = {
	complete: "Complete",
	interrupted: "Interrupted",
	aborted: "Aborted",
	error: "Ended with an error",
	pending: "In progress",
	unknown: "Status unknown",
};

/** Human label for a status dot (screen-reader text and tooltip). */
export function sessionStatusLabel(status: SessionStatus | undefined): string {
	return STATUS_LABELS[status ?? "unknown"];
}

/** One session as every list surface renders it. Identity is `id` + `file`. */
export interface SessionRow {
	id: string;
	/** Absolute session log path (`.jsonl`). */
	file: string;
	title?: string;
	cwd: string;
	/** Short project name for rows from other projects (last cwd segment). */
	projectLabel: string;
	createdMs?: number;
	modifiedMs: number;
	messageCount: number;
	status?: SessionStatus;
	/** First user prompt (<= 500 chars; the session may send "(no messages)"). */
	firstMessage?: string;
	/** Tail of the conversation text, shown in the preview pane. */
	recentText?: string;
	/** Built from the session's indexed title alone (no cwd, first prompt, message count or status), until its full scan lands. */
	partial?: boolean;
	pinned: boolean;
	scope: "local" | "global";
	/** The session attached to this browser right now. */
	current?: boolean;
	/** Set when no registered project owns the folder: the row cannot resume until the folder is added. */
	blocked?: { reason: string; addProjectPath: string };
}

/** A roster session as owner resolution sees it. */
export interface SessionOwnerEntry {
	workspaceId: string;
	cwd: string;
	status: ProcessStatus;
}

/** A registered project as owner resolution sees it. */
export interface SessionOwnerProject {
	projectId: string;
	path: string;
}

/** Who a session's folder resolves to: a session, several (ambiguous), a registered project, or nobody. */
export type SessionOwner =
	| { kind: "workspace"; workspaceId: string }
	| { kind: "ambiguous"; workspaceIds: string[] }
	| { kind: "project"; projectId: string; path: string }
	| { kind: "none" };

export function trimTrailingSlashes(path: string): string {
	return path.replace(/\/+$/, "");
}

/**
 * Resolve the owner of a session folder. A session on the exact folder wins; several
 * sessions on it stay `ambiguous` so the caller keeps the explicit choice. Otherwise the
 * longest registered project that is the folder or one of its parents owns it (it is
 * started on resume). A sibling prefix (`/work/foobar` vs `/work/foo`) never matches.
 */
export function resolveSessionOwner(
	cwd: string,
	ctx: { roster: readonly SessionOwnerEntry[]; projects: readonly SessionOwnerProject[] },
): SessionOwner {
	const folder = trimTrailingSlashes(cwd);
	if (folder === "") return { kind: "none" };
	const onFolder = ctx.roster.filter((session) => trimTrailingSlashes(session.cwd) === folder);
	const [only] = onFolder;
	if (only && onFolder.length === 1) return { kind: "workspace", workspaceId: only.workspaceId };
	if (onFolder.length > 1)
		return { kind: "ambiguous", workspaceIds: onFolder.map((session) => session.workspaceId) };
	let owner: SessionOwnerProject | undefined;
	for (const project of ctx.projects) {
		const root = trimTrailingSlashes(project.path);
		if (root === "" || (folder !== root && !folder.startsWith(`${root}/`))) continue;
		if (!owner || root.length > trimTrailingSlashes(owner.path).length) owner = project;
	}
	return owner
		? { kind: "project", projectId: owner.projectId, path: owner.path }
		: { kind: "none" };
}

export type SessionGroupKey = "pinned" | "today" | "earlier";

export interface SessionGroup {
	key: SessionGroupKey;
	label: string;
	rows: SessionRow[];
	count: number;
}

export interface GroupedSessions {
	groups: SessionGroup[];
	/** Sum of every group's count: the one number every header and footer shows. */
	total: number;
}

const GROUP_LABELS: Record<SessionGroupKey, string> = {
	pinned: "Pinned",
	today: "Today",
	earlier: "Earlier",
};

const NO_MESSAGES = "(no messages)";
const TITLE_MAX = 80;

/** Start of the local calendar day containing `nowMs`. */
function startOfLocalDay(nowMs: number): number {
	const d = new Date(nowMs);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

/**
 * Pinned (newest first), Today (local calendar day of `nowMs`), then Earlier.
 * Empty groups are omitted. Nothing is filtered or dropped, so
 * `total === sum(group.count)`.
 */
export function groupSessions(rows: readonly SessionRow[], nowMs: number): GroupedSessions {
	const dayStart = startOfLocalDay(nowMs);
	const buckets: Record<SessionGroupKey, SessionRow[]> = { pinned: [], today: [], earlier: [] };
	for (const row of rows) {
		if (row.pinned) buckets.pinned.push(row);
		else if (row.modifiedMs >= dayStart) buckets.today.push(row);
		else buckets.earlier.push(row);
	}
	const groups: SessionGroup[] = [];
	for (const key of ["pinned", "today", "earlier"] as const) {
		const list = buckets[key].toSorted((a, b) => b.modifiedMs - a.modifiedMs);
		if (list.length > 0)
			groups.push({ key, label: GROUP_LABELS[key], rows: list, count: list.length });
	}
	return { groups, total: groups.reduce((sum, g) => sum + g.count, 0) };
}

function firstLine(text: string | undefined): string {
	if (text === undefined) return "";
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed) return trimmed;
	}
	return "";
}

/** First line of the first prompt, or "" when the session has none. */
function promptLine(row: SessionRow): string {
	const line = firstLine(row.firstMessage);
	return line === NO_MESSAGES ? "" : line;
}

/** The explicit title the user or agent gave, or "" (ids never count as titles). */
function explicitTitle(row: SessionRow): string {
	const title = displayTitle(row.title)?.trim() ?? "";
	return title === row.id ? "" : title;
}

/**
 * What a row is called: the explicit title, else the first prompt's first
 * line, else `Untitled · <local time>`. Never a raw id or file name.
 */
export function sessionDisplayTitle(row: SessionRow): string {
	const title = explicitTitle(row);
	if (title) return title;
	const prompt = promptLine(row);
	if (prompt) {
		return prompt.length > TITLE_MAX ? `${prompt.slice(0, TITLE_MAX - 1).trimEnd()}…` : prompt;
	}
	const stamp = row.modifiedMs || row.createdMs;
	if (!stamp) return "Untitled";
	const time = new Date(stamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	return `Untitled · ${time}`;
}

/**
 * What an expanded row shows: the latest conversation, else the first prompt; "" when it
 * has neither, or when the first prompt is already shown whole as the row's title.
 */
export function sessionExpandText(row: SessionRow): string {
	const recent = row.recentText?.trim();
	if (recent) return recent;
	const prompt = row.firstMessage?.trim();
	if (!prompt || prompt === NO_MESSAGES) return "";
	const titledByPrompt = !explicitTitle(row) && prompt === promptLine(row);
	return titledByPrompt && prompt.length <= TITLE_MAX ? "" : prompt;
}

/** A fleet `SessionListEntry` (list_workspace_sessions / EmptyTranscript) as a SessionRow; no pin state. */
export function sessionRowFromListEntry(
	entry: SessionListEntry,
	currentFile: string | undefined,
): SessionRow {
	const status = sessionStatus(entry.status);
	return {
		id: entry.id,
		file: entry.path,
		...(entry.name ? { title: entry.name } : {}),
		...(entry.firstMessage ? { firstMessage: entry.firstMessage } : {}),
		...(status !== undefined ? { status } : {}),
		cwd: entry.cwd,
		projectLabel: projectLabelFromCwd(entry.cwd),
		modifiedMs: entry.modifiedAt,
		messageCount: entry.messageCount,
		pinned: false,
		scope: "local",
		current: entry.path === currentFile,
	};
}

/** Short project name for a cwd: its last path segment. */
export function projectLabelFromCwd(cwd: string): string {
	const segments = cwd.split(/[\\/]/).filter(Boolean);
	return segments.at(-1) ?? "(no directory)";
}

/**
 * Case-insensitive literal search: every whitespace-separated term must occur
 * in the title, cwd, id, first prompt or recent conversation text.
 */
export function matchSessionRow(row: SessionRow, query: string): boolean {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return true;
	const haystack = [row.title, row.cwd, row.id, row.firstMessage, row.recentText]
		.filter((part): part is string => typeof part === "string")
		.join("\n")
		.toLowerCase();
	return terms.every((term) => haystack.includes(term));
}

/** Compact relative age against an explicit clock; past a week, the local date. */
export function formatSessionAge(ms: number, nowMs: number): string {
	if (!ms) return "unknown time";
	const diff = nowMs - ms;
	if (diff < 60_000) return "just now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
	return new Date(ms).toLocaleDateString();
}

export const SESSION_TITLE_MAX = 200;

/** Trimmed single-line session title (1..200 chars), or null when unusable. */
export function normalizeSessionTitle(raw: string): string | null {
	const title = raw.replace(/\s+/g, " ").trim();
	return title.length >= 1 && title.length <= SESSION_TITLE_MAX ? title : null;
}

export interface SessionDeleteContext {
	/** The session file attached to this browser, if any. */
	attachedFile: string | null;
	/** The session advertises rename/delete of non-attached sessions. */
	manageAvailable: boolean;
}

export type SessionDeleteCheck =
	| {
			ok: true;
			/** Delete goes through the attached-session `deleteSession` call. */ current: boolean;
	  }
	| { ok: false; reason: string };

/**
 * Client-side guard the store consults before it asks the session to delete.
 * The session stays authoritative (realpath jail, listing membership, header
 * id, writer lock); this only refuses what can never be valid.
 */
export function validateSessionDelete(
	row: Pick<SessionRow, "id" | "file" | "current">,
	ctx: SessionDeleteContext,
): SessionDeleteCheck {
	if (!row.id) return { ok: false, reason: "This session has no id, so it cannot be deleted." };
	if (!row.file)
		return { ok: false, reason: "This session has no log file, so it cannot be deleted." };
	if (!/\.jsonl$/i.test(row.file)) {
		return { ok: false, reason: "Only .jsonl session logs can be deleted." };
	}
	if (row.current === true || row.file === ctx.attachedFile) return { ok: true, current: true };
	if (!ctx.manageAvailable) {
		return { ok: false, reason: "This server cannot delete sessions that are not attached." };
	}
	return { ok: true, current: false };
}
