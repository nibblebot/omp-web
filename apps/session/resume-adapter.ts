/**
 * Targeted resume and resume-list pins: session-side adapter.
 *
 * OWNERSHIP: this module is the ONLY place that composes the SDK resume /
 * pins surface for browser-driven resume. Session method wiring in methods.ts
 * calls {@link createResumeHandlers}; the fleet edge, protocol, state and web
 * prompt command table are NEVER touched here.
 *
 * SDK reuse (installed @oh-my-pi/pi-coding-agent 18.12.6; revalidate on bump):
 * - session/session-listing.ts: `listSessions`, `listAllSessions`,
 *   `filterSessionsForPicker` (empties dropped, pins kept). The matcher
 *   `sessionMatchesResumeArg` and `sessionIdFromSessionPath` are
 *   module-PRIVATE in the SDK, so {@link matchesResumeArg} below mirrors
 *   their exact grammar (case-insensitive ID-prefix, filename-prefix,
 *   fileSessionId-after-last-underscore) instead of inventing a second one.
 * - session/session-pins.ts: `loadPinnedSessionIds` / `toggleSessionPin`
 *   (cross-process file lock, atomic replace; server-owned file, durable
 *   across restart) + `sortPinnedFirst` (stable pinned-first; unknown ids
 *   no-op).
 * - session/session-paths.ts: `computeDefaultSessionDir` (canonical
 *   cwd-derived dir, same derivation the session's list_sessions uses).
 *
 * SECURITY: ID/prefix/allowed-host-paths only. Path-shaped args are
 * realpath-jailed to the session dir and must resolve to a KNOWN session
 * file — recoverable files are never invented. Secrets and tokens never
 * appear in DTOs. No stdout writes (OMP_SESSION| reserved).
 *
 * Wire handlers use the existing call_result transport.
 */

import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
	filterSessionsForPicker,
	listAllSessions,
	listSessions,
	type SessionInfo,
	type SessionStatus,
} from "@oh-my-pi/pi-coding-agent/session/session-listing";
import {
	loadPinnedSessionIds,
	sortPinnedFirst,
	toggleSessionPin,
} from "@oh-my-pi/pi-coding-agent/session/session-pins";
import { computeDefaultSessionDir } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type { LifecycleMirror } from "./lifecycle-adapter";
import {
	deleteResumeSession,
	renameResumeSession,
	ResumeInputError,
	type ResumeManageDeps,
} from "./resume-manage";
import type { SessionEntry } from "./session-entry";

// ---------------------------------------------------------------------------
// Shared shapes (JSON-safe; Dates are epoch millis, Sets are arrays)
// ---------------------------------------------------------------------------

/** One resumable session for the picker. Identity is `id` + `sessionFile`. */
export interface ResumeCandidate {
	id: string;
	/** Absolute main JSONL path — the switchSession argument. */
	sessionFile: string;
	cwd: string;
	title?: string;
	createdMs: number;
	modifiedMs: number;
	messageCount: number;
	size: number;
	status?: SessionStatus;
	/** Capped display snippet (never the full transcript). */
	firstMessage: string;
	/** Last <=600 chars of conversation text (preview pane). */
	recentText?: string;
	pinned: boolean;
	scope: "local" | "global";
}

/** Capability pair for server-advertised availability (never version-guessed). */
export interface ResumeCapability {
	available: boolean;
	reason?: string;
}

export type ResumeRefusalReason = "unauthorized-path" | "missing-arg";

export type ResolveResumeTarget =
	| { kind: "unique"; session: ResumeCandidate; scope: "local" | "global" }
	| { kind: "ambiguous"; candidates: ResumeCandidate[] }
	| { kind: "missing"; scopeChecked: "local" | "global"; searched: number }
	| { kind: "refused"; reason: ResumeRefusalReason; message: string };

/** Cap on ambiguous-choice lists (ID prefixes can match many sessions). */
export const AMBIGUOUS_CAP = 20;

/** Default/max rows for resumeList. Mirrors the session list_sessions ceiling. */
export const RESUME_LIST_DEFAULT_LIMIT = 100;
export const RESUME_LIST_MAX_LIMIT = 200;

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// ---------------------------------------------------------------------------
// Resume selector grammar (mirrors the SDK-private sessionMatchesResumeArg)
// ---------------------------------------------------------------------------

/**
 * Case-insensitive ID-prefix, filename-prefix, or fileSessionId-after-last-
 * underscore match. Kept byte-identical to the SDK's private matcher so the
 * browser resolves exactly what the TUI `/resume <arg>` resolves.
 */
export function matchesResumeArg(id: string, sessionPath: string, sessionArg: string): boolean {
	const normalizedArg = sessionArg.toLowerCase();
	if (normalizedArg.length === 0) return false;
	if (id.toLowerCase().startsWith(normalizedArg)) return true;
	const fileName = path.basename(sessionPath, ".jsonl").toLowerCase();
	if (fileName.startsWith(normalizedArg)) return true;
	const separator = fileName.lastIndexOf("_");
	if (separator < 0) return false;
	return fileName.slice(separator + 1).startsWith(normalizedArg);
}

function toCandidate(
	info: SessionInfo,
	scope: "local" | "global",
	pinned: ReadonlySet<string>,
): ResumeCandidate {
	const recentText = info.allMessagesText.slice(-600).trim();
	return {
		id: info.id,
		sessionFile: info.path,
		cwd: info.cwd,
		...(info.title !== undefined ? { title: info.title } : {}),
		createdMs: info.created.getTime(),
		modifiedMs: info.modified.getTime(),
		messageCount: info.messageCount,
		size: info.size,
		...(info.status !== undefined ? { status: info.status } : {}),
		firstMessage: info.firstMessage.slice(0, 500),
		...(recentText.length > 0 ? { recentText } : {}),
		pinned: pinned.has(info.id),
		scope,
	};
}

export interface ResumeQuery {
	cwd: string;
	sessionDir?: string;
	agentDir?: string;
	allowGlobalFallback?: boolean;
}

function resolveSessionDir(query: ResumeQuery): string {
	return query.sessionDir ?? computeDefaultSessionDir(query.cwd, new FileSessionStorage());
}

/** True when the arg is path-shaped (never treated as an ID prefix). */
function looksLikePath(arg: string): boolean {
	return arg.includes("/") || arg.includes("\\") || arg.endsWith(".jsonl") || arg.startsWith(".");
}

/** Realpath of `candidate`, or null when it does not exist. */
async function tryRealpath(candidate: string): Promise<string | null> {
	try {
		return await realpath(candidate);
	} catch {
		return null;
	}
}

/**
 * Resolve a resume argument to a unique session, an explicit ambiguous
 * choice list, a scoped miss, or a refusal. Bare/empty input is a miss (the
 * web store opens the picker instead). Wrong profile/workspace/cwd scoping
 * beyond this session is refused roster-side by the web store (wake/switch of
 * the owning session via the existing spawn_resume+attach path) — this
 * adapter never spawns a parallel attachment.
 */
export async function resolveResumeTarget(
	sessionArg: string,
	query: ResumeQuery,
): Promise<ResolveResumeTarget> {
	const raw = sessionArg.trim();
	if (raw.length === 0) {
		return {
			kind: "refused",
			reason: "missing-arg",
			message: "Provide a session ID, ID prefix, or authorized session path.",
		};
	}
	const sessionDir = resolveSessionDir(query);
	const storage = new FileSessionStorage();
	const pinned = await loadPinnedSessionIds(query.agentDir);

	// Path-shaped args: realpath jail to the session dir, then membership
	// against KNOWN session files only. Outside the dir -> refused; inside
	// but unknown/missing -> missing (never invent a recoverable file).
	if (looksLikePath(raw)) {
		const realDir = await tryRealpath(sessionDir);
		if (realDir === null) {
			return { kind: "missing", scopeChecked: "local", searched: 0 };
		}
		const candidate = path.resolve(query.cwd, raw);
		const realCandidate = await tryRealpath(candidate);
		if (realCandidate === null) {
			return { kind: "missing", scopeChecked: "local", searched: 0 };
		}
		const rel = path.relative(realDir, realCandidate);
		if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
			return {
				kind: "refused",
				reason: "unauthorized-path",
				message: "Session paths must live inside this project's session directory.",
			};
		}
		const local = await listSessions(sessionDir, storage);
		const match = local.find((s) => s.path === realCandidate || s.path === candidate);
		if (!match) {
			return { kind: "missing", scopeChecked: "local", searched: local.length };
		}
		return { kind: "unique", session: toCandidate(match, "local", pinned), scope: "local" };
	}

	// ID / prefix grammar: local first, then the SDK's global fallback rule
	// (explicit sessionDir opts out unless allowGlobalFallback is set).
	const local = await listSessions(sessionDir, storage);
	const localMatches = local.filter((s) => matchesResumeArg(s.id, s.path, raw));
	if (localMatches.length === 1 && localMatches[0]) {
		return {
			kind: "unique",
			session: toCandidate(localMatches[0], "local", pinned),
			scope: "local",
		};
	}
	if (localMatches.length > 1) {
		return {
			kind: "ambiguous",
			candidates: localMatches.slice(0, AMBIGUOUS_CAP).map((s) => toCandidate(s, "local", pinned)),
		};
	}
	const mayFallBack = query.sessionDir === undefined || query.allowGlobalFallback === true;
	if (!mayFallBack) {
		return { kind: "missing", scopeChecked: "local", searched: local.length };
	}
	const global = await listAllSessions(storage);
	const globalMatches = global.filter((s) => matchesResumeArg(s.id, s.path, raw));
	if (globalMatches.length === 1 && globalMatches[0]) {
		return {
			kind: "unique",
			session: toCandidate(globalMatches[0], "global", pinned),
			scope: "global",
		};
	}
	if (globalMatches.length > 1) {
		return {
			kind: "ambiguous",
			candidates: globalMatches
				.slice(0, AMBIGUOUS_CAP)
				.map((s) => toCandidate(s, "global", pinned)),
		};
	}
	return { kind: "missing", scopeChecked: "global", searched: local.length + global.length };
}

// ---------------------------------------------------------------------------
// Resume listing + durable pins
// ---------------------------------------------------------------------------

export interface ListResumeCandidatesOptions {
	cwd: string;
	sessionDir?: string;
	/** Agent sessions root; required to list other projects (`allProjects`). */
	sessionsRoot?: string;
	agentDir?: string;
	pinnedIds?: ReadonlySet<string>;
	query?: string;
	limit?: number;
	allProjects?: boolean;
}

export interface ResumeListResult {
	candidates: ResumeCandidate[];
	pinnedIds: string[];
	sessionDir: string;
	total: number;
	allProjects: boolean;
}

/**
 * Picker listing: empties dropped (pins kept) via `filterSessionsForPicker`,
 * pinned-first via `sortPinnedFirst`, optional search over id/prefix, title,
 * cwd, first prompt, and full conversation text. Without `allProjects` only
 * this project's directory is listed (`scope: "local"`); with it every project
 * under the sessions root is listed and other projects' rows are `"global"`.
 */
export async function listResumeCandidates(
	options: ListResumeCandidatesOptions,
): Promise<ResumeListResult> {
	const sessionDir = options.sessionDir ?? resolveSessionDir({ cwd: options.cwd });
	const allProjects = options.allProjects === true;
	const storage = new FileSessionStorage();
	const [sessions, pinned] = await Promise.all([
		allProjects
			? listAllSessions(storage, options.sessionsRoot)
			: listSessions(sessionDir, storage),
		options.pinnedIds !== undefined
			? Promise.resolve(options.pinnedIds)
			: loadPinnedSessionIds(options.agentDir),
	]);
	const localDir = path.resolve(sessionDir);
	const scopeOf = (s: SessionInfo): "local" | "global" =>
		allProjects && path.dirname(path.resolve(s.path)) !== localDir ? "global" : "local";
	const q = (options.query ?? "").trim().toLowerCase();
	const searched =
		q.length === 0
			? sessions
			: sessions.filter(
					(s) =>
						matchesResumeArg(s.id, s.path, q) ||
						(s.title ?? "").toLowerCase().includes(q) ||
						s.cwd.toLowerCase().includes(q) ||
						s.firstMessage.toLowerCase().includes(q) ||
						s.allMessagesText.toLowerCase().includes(q),
				);
	const picked = filterSessionsForPicker(searched, pinned);
	const ordered = sortPinnedFirst(picked, pinned);
	const limit = Math.min(
		Math.max(options.limit ?? RESUME_LIST_DEFAULT_LIMIT, 1),
		RESUME_LIST_MAX_LIMIT,
	);
	return {
		candidates: ordered.slice(0, limit).map((s) => toCandidate(s, scopeOf(s), pinned)),
		pinnedIds: [...pinned],
		sessionDir,
		total: ordered.length,
		allProjects,
	};
}

/**
 * Toggle one resume-list pin (durable: server-owned pins file, survives
 * restart). UI copy MUST call this a "resume-list pin": it only orders the
 * resume picker — it is not a credential/account pin (automatic OAuth
 * session stickiness) and it does not change what the model keeps in
 * context.
 */
export async function toggleResumePin(
	sessionId: string,
	agentDir?: string,
): Promise<{ pinned: boolean; pinnedIds: string[] }> {
	if (!SESSION_ID_RE.test(sessionId)) {
		throw new ResumeInputError(`unsafe sessionId: ${sessionId}`);
	}
	const pinned =
		agentDir === undefined
			? await toggleSessionPin(sessionId)
			: await toggleSessionPin(sessionId, agentDir);
	const pinnedIds = await loadPinnedSessionIds(agentDir);
	return { pinned, pinnedIds: [...pinnedIds] };
}

// ---------------------------------------------------------------------------
// Method binder (single integration point; methods.ts is the only caller)
// ---------------------------------------------------------------------------

export interface ResumeContext extends ResumeQuery {
	/** Agent sessions root (every project dir); cross-project listing. */
	sessionsRoot?: string;
	/** Fleet mirror for acknowledged deletion; absent on unpaired sessions. */
	lifecycleMirror?: LifecycleMirror;
}

function argAt(args: unknown[], index: number): Record<string, unknown> {
	const first = args[index];
	if (typeof first === "object" && first !== null) return first as Record<string, unknown>;
	return {};
}

function strField(obj: Record<string, unknown>, key: string): string | undefined {
	const v = obj[key];
	return typeof v === "string" ? v : undefined;
}

/** Named `call` handler table returned by {@link createResumeHandlers}. */
export type ResumeHandlers = Record<
	string,
	(args: unknown[], entry?: SessionEntry) => Promise<unknown>
>;

/**
 * Build the session `call` handlers methods.ts publishes. Each handler takes the raw
 * `args` array and returns JSON-safe values; throws carry typed
 * invalid_request/unavailable messages to the caller (duplicate call ids
 * replay the recorded answer via the existing dedup window — no new
 * transport here).
 */
export function createResumeHandlers(ctx: ResumeContext): ResumeHandlers {
	function manageDeps(entry?: SessionEntry): ResumeManageDeps {
		if (ctx.sessionsRoot === undefined) {
			throw new Error("Session management requires the agent sessions root");
		}
		return {
			sessionsRoot: ctx.sessionsRoot,
			...(entry !== undefined ? { attached: entry } : {}),
			...(ctx.lifecycleMirror !== undefined ? { mirror: ctx.lifecycleMirror } : {}),
			unpin: async (sessionId) => {
				if ((await loadPinnedSessionIds(ctx.agentDir)).has(sessionId)) {
					await toggleResumePin(sessionId, ctx.agentDir);
				}
			},
		};
	}
	return {
		getResumeCapabilities: async () => ({
			resolve: { available: true } satisfies ResumeCapability,
			manage: { available: true } satisfies ResumeCapability,
		}),
		resumeResolve: async (args) => {
			const obj = argAt(args, 0);
			const arg = strField(obj, "arg") ?? (typeof args[0] === "string" ? args[0] : "");
			return resolveResumeTarget(arg, {
				cwd: ctx.cwd,
				sessionDir: ctx.sessionDir,
				allowGlobalFallback: ctx.allowGlobalFallback,
				agentDir: ctx.agentDir,
			});
		},
		resumeList: async (args) => {
			const obj = argAt(args, 0);
			const query = strField(obj, "query");
			const limit = typeof obj.limit === "number" ? obj.limit : undefined;
			return listResumeCandidates({
				cwd: ctx.cwd,
				sessionDir: ctx.sessionDir,
				sessionsRoot: ctx.sessionsRoot,
				agentDir: ctx.agentDir,
				allProjects: obj.allProjects === true,
				...(query !== undefined ? { query } : {}),
				...(limit !== undefined ? { limit } : {}),
			});
		},
		resumeRename: async (args, entry) => {
			const obj = argAt(args, 0);
			return renameResumeSession(
				{ sessionFile: strField(obj, "sessionFile") ?? "", title: strField(obj, "title") ?? "" },
				manageDeps(entry),
			);
		},
		resumeDelete: async (args, entry) => {
			const obj = argAt(args, 0);
			return deleteResumeSession(
				{
					sessionFile: strField(obj, "sessionFile") ?? "",
					sessionId: strField(obj, "sessionId") ?? "",
				},
				manageDeps(entry),
			);
		},
	};
}

/** Realpath-jail probe (exported for tests): null when `candidate` is absent. */
export async function probeRealpath(candidate: string): Promise<string | null> {
	try {
		await stat(candidate);
		return await realpath(candidate);
	} catch {
		return null;
	}
}
