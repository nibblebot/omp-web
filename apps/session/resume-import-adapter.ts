/**
 * G20 targeted resume, pins and foreign imports — daemon-side adapter (P6).
 *
 * OWNERSHIP: this module is the ONLY place that composes the SDK resume /
 * pins / foreign-import surface for browser-driven resume. Daemon method
 * wiring (P0) calls {@link createResumeImportHandlers}; the fleet edge,
 * protocol, state and web prompt command table are NEVER touched here.
 *
 * SDK reuse (installed @oh-my-pi/pi-coding-agent 18.6.1; revalidate on bump):
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
 * - session/foreign-session-store.ts + foreign-session-import.ts +
 *   claude/codex-session-store.ts: `createForeignSessionStore`,
 *   `foreignSessionSourceName`, `foreignSessionInfoToSessionInfo`
 *   (picker projection only), `persistForeignSession` (fresh native identity
 *   + `foreign_session_import` breadcrumb; NEVER mutates the foreign
 *   original; `fallbackCwd` move when the recorded cwd is missing).
 * - session/session-paths.ts: `computeDefaultSessionDir` (canonical
 *   cwd-derived dir, same derivation the daemon's list_sessions uses).
 * - ./session-materialize.ts: `sessionTreeExists` /
 *   `resolveSessionMainFile` (warm verify) — cold fill runs through the
 *   injected callback-pair materializer (same seam methods.ts uses), never a
 *   parallel attachment path.
 *
 * SECURITY: ID/prefix/allowed-host-paths only. Path-shaped args are
 * realpath-jailed to the session dir and must resolve to a KNOWN session
 * file — recoverable files are never invented. Upload bytes are size/type
 * validated (JSONL-ish, 64 MiB cap, executables/symlinks rejected) and
 * staged to a private temp file that is removed after import. Secrets and
 * tokens never appear in DTOs. No stdout writes (OMP_SESSION| reserved).
 *
 * Wire handlers use the existing call_result transport. Foreign roots are
 * authorized by daemon configuration, and selections retain their server-owned
 * store identity from listing through preview/import.
 */

import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveClaudePaths } from "@oh-my-pi/pi-coding-agent/config/claude-paths";
import { ClaudeSessionStore } from "@oh-my-pi/pi-coding-agent/session/claude-session-store";
import { CodexSessionStore } from "@oh-my-pi/pi-coding-agent/session/codex-session-store";
import {
	createForeignSessionStore,
	foreignSessionSourceName,
	persistForeignSession,
} from "@oh-my-pi/pi-coding-agent/session/foreign-session-import";
import type {
	ForeignSessionInfo,
	ForeignSessionSource,
	ForeignSessionStore,
} from "@oh-my-pi/pi-coding-agent/session/foreign-session-store";
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
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { resolveSessionMainFile, sessionTreeExists } from "./session-materialize";

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

/** Default/max rows for resumeList. Mirrors the daemon list_sessions ceiling. */
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
 * beyond this daemon is refused roster-side by the web store (wake/switch of
 * the owning daemon via the existing spawn_resume+attach path) — this
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
	agentDir?: string;
	pinnedIds?: ReadonlySet<string>;
	query?: string;
	limit?: number;
}

export interface ResumeListResult {
	candidates: ResumeCandidate[];
	pinnedIds: string[];
	sessionDir: string;
	total: number;
}

/**
 * Picker listing: empties dropped (pins kept) via `filterSessionsForPicker`,
 * pinned-first via `sortPinnedFirst`, optional ID/prefix/title/cwd search.
 * Provenance: every row is a live local transcript (`scope: "local"`);
 * fleet-stored (read-only/unavailable) rows stay in the tx/api stored*
 * surface, which never wakes compute.
 */
export async function listResumeCandidates(
	options: ListResumeCandidatesOptions,
): Promise<ResumeListResult> {
	const sessionDir = options.sessionDir ?? resolveSessionDir({ cwd: options.cwd });
	const storage = new FileSessionStorage();
	const [sessions, pinned] = await Promise.all([
		listSessions(sessionDir, storage),
		options.pinnedIds !== undefined
			? Promise.resolve(options.pinnedIds)
			: loadPinnedSessionIds(options.agentDir),
	]);
	const q = (options.query ?? "").trim().toLowerCase();
	const searched =
		q.length === 0
			? sessions
			: sessions.filter(
					(s) =>
						matchesResumeArg(s.id, s.path, q) ||
						(s.title ?? "").toLowerCase().includes(q) ||
						s.cwd.toLowerCase().includes(q),
				);
	const picked = filterSessionsForPicker(searched, pinned);
	const ordered = sortPinnedFirst(picked, pinned);
	const limit = Math.min(
		Math.max(options.limit ?? RESUME_LIST_DEFAULT_LIMIT, 1),
		RESUME_LIST_MAX_LIMIT,
	);
	return {
		candidates: ordered.slice(0, limit).map((s) => toCandidate(s, "local", pinned)),
		pinnedIds: [...pinned],
		sessionDir,
		total: ordered.length,
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

export class ResumeInputError extends Error {
	readonly code = "invalid_request" as const;
}

// ---------------------------------------------------------------------------
// Foreign sessions (Claude/Codex import; never mutate the original)
// ---------------------------------------------------------------------------

export const FOREIGN_UPLOAD_MAX_BYTES = 64 * 1024 * 1024;
const FOREIGN_UPLOAD_EXTENSIONS: Record<string, true> = { ".jsonl": true, ".json": true };

export class ForeignImportError extends Error {
	readonly code: "invalid_request" | "unavailable";
	constructor(code: "invalid_request" | "unavailable", message: string) {
		super(message);
		this.code = code;
	}
}

/** Serializable foreign-session metadata (list/preview only, no transcript). */
export interface ForeignSessionPreview {
	source: ForeignSessionSource;
	sourceName: string;
	id: string;
	path: string;
	cwd: string;
	title?: string;
	createdMs: number;
	modifiedMs: number;
	messageCount: number;
	firstMessage?: string;
	/** Set for staged user uploads (server temp path, cancelled on import). */
	staged?: boolean;
}

export interface ImportedForeignSession {
	sessionId: string;
	sessionFile: string;
	provenance: {
		source: ForeignSessionSource;
		sourceName: string;
		sourceId: string;
		sourcePath: string;
		sourceCwd: string;
		stagedUpload: boolean;
	};
}

export function foreignPreviewOf(info: ForeignSessionInfo): ForeignSessionPreview {
	return {
		source: info.source,
		sourceName: foreignSessionSourceName(info.source),
		id: info.id,
		path: info.path,
		cwd: info.cwd,
		...(info.title !== undefined ? { title: info.title } : {}),
		createdMs: info.created.getTime(),
		modifiedMs: info.modified.getTime(),
		messageCount: info.messageCount ?? 0,
		...(info.firstMessage !== undefined ? { firstMessage: info.firstMessage.slice(0, 500) } : {}),
	};
}

function assertSource(source: unknown): asserts source is ForeignSessionSource {
	if (source !== "claude" && source !== "codex") {
		throw new ForeignImportError(
			"invalid_request",
			`unsupported foreign source: ${String(source)}`,
		);
	}
}

/** Guard an authorized fleet-host root: absolute, real directory, no symlink. */
async function resolveAuthorizedRoot(root: string): Promise<string> {
	if (!path.isAbsolute(root)) {
		throw new ForeignImportError("invalid_request", "foreign root must be an absolute path");
	}
	await assertNoSymlinkAncestry(root);
	let st;
	try {
		st = await lstat(root);
	} catch {
		throw new ForeignImportError("unavailable", "foreign root is not accessible");
	}
	if (st.isSymbolicLink() || !st.isDirectory()) {
		throw new ForeignImportError("invalid_request", "foreign root must be a real directory");
	}
	const real = await tryRealpath(root);
	if (real === null) {
		throw new ForeignImportError("unavailable", "foreign root is not accessible");
	}
	return real;
}

function storeFor(source: ForeignSessionSource, root?: string): ForeignSessionStore {
	if (root === undefined) return createForeignSessionStore(source);
	return source === "claude" ? new ClaudeSessionStore(root) : new CodexSessionStore(root);
}

/**
 * List foreign sessions from the default source location or an authorized
 * fleet-host root. Metadata only (the SDK list() reads a bounded prefix when
 * indexed metadata is absent) — never a full-transcript load.
 */
export async function listForeignSessions(
	source: ForeignSessionSource,
	options?: { authorizedRoot?: string },
): Promise<ForeignSessionPreview[]> {
	assertSource(source);
	const root =
		options?.authorizedRoot !== undefined
			? await resolveAuthorizedRoot(options.authorizedRoot)
			: undefined;
	const store = storeFor(source, root);
	const infos = await store.list();
	return infos.map(foreignPreviewOf);
}

/**
 * Preview one foreign session: title/cwd/created/modified/messageCount/
 * firstMessage with NO full-transcript load. `info` may be a preview round-
 * tripped from listForeignSessions (path/cwd are display only here).
 */
export function previewForeignSession(
	store: ForeignSessionStore,
	info: ForeignSessionInfo | ForeignSessionPreview,
): ForeignSessionPreview {
	if (info.source !== store.source) {
		throw new ForeignImportError(
			"invalid_request",
			`Cannot preview a ${info.source} session with the ${store.source} importer`,
		);
	}
	return {
		source: info.source,
		sourceName: foreignSessionSourceName(info.source),
		id: info.id,
		path: info.path,
		cwd: info.cwd,
		...(info.title !== undefined ? { title: info.title } : {}),
		createdMs:
			info instanceof Object && "createdMs" in info
				? (info as ForeignSessionPreview).createdMs
				: (info as ForeignSessionInfo).created.getTime(),
		modifiedMs:
			"modifiedMs" in info
				? (info as ForeignSessionPreview).modifiedMs
				: (info as ForeignSessionInfo).modified.getTime(),
		messageCount: info.messageCount ?? 0,
		...(info.firstMessage !== undefined ? { firstMessage: info.firstMessage.slice(0, 500) } : {}),
		...("staged" in info && (info as ForeignSessionPreview).staged === true
			? { staged: true }
			: {}),
	};
}

async function assertNoSymlinkAncestry(file: string): Promise<void> {
	let cursor = path.resolve(file);
	for (;;) {
		const entry = await lstat(cursor);
		if (entry.isSymbolicLink()) {
			throw new ForeignImportError("invalid_request", "foreign paths must not contain symlinks");
		}
		const parent = path.dirname(cursor);
		if (parent === cursor) return;
		cursor = parent;
	}
}

function isWithin(root: string, file: string): boolean {
	const relative = path.relative(root, path.resolve(file));
	return (
		relative === "" ||
		(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
	);
}

/** Guard a foreign source file before load: regular file, no symlink, capped. */
async function assertImportableFile(info: ForeignSessionInfo): Promise<void> {
	let st;
	try {
		st = await lstat(info.path);
	} catch {
		throw new ForeignImportError(
			"unavailable",
			`foreign session file is not accessible: ${info.id}`,
		);
	}
	if (st.isSymbolicLink() || !st.isFile()) {
		throw new ForeignImportError("invalid_request", "foreign session must be a regular file");
	}
	if (st.size > FOREIGN_UPLOAD_MAX_BYTES) {
		throw new ForeignImportError(
			"invalid_request",
			`foreign session exceeds the ${FOREIGN_UPLOAD_MAX_BYTES / 1024 / 1024} MiB import cap`,
		);
	}
	if (st.size === 0) {
		throw new ForeignImportError("invalid_request", "foreign session file is empty");
	}
	await assertNoSymlinkAncestry(info.path);
	validateForeignUpload(await readFile(info.path), info.path);
}

/**
 * Import one foreign session to a NEW native identity with provenance (the
 * `foreign_session_import` breadcrumb the SDK appends: source/sourceId/
 * sourcePath/sourceCwd). The foreign original is only read, never written.
 */
export async function importForeignSession(
	store: ForeignSessionStore,
	info: ForeignSessionInfo,
	options?: { sessionDir?: string; fallbackCwd?: string },
): Promise<ImportedForeignSession> {
	if (info.source !== store.source) {
		throw new ForeignImportError(
			"invalid_request",
			`Cannot import a ${info.source} session with the ${store.source} importer`,
		);
	}
	await assertImportableFile(info);
	let manager: SessionManager;
	try {
		manager = await persistForeignSession(store, info, {
			...(options?.sessionDir !== undefined ? { sessionDir: options.sessionDir } : {}),
			...(options?.fallbackCwd !== undefined ? { fallbackCwd: options.fallbackCwd } : {}),
		});
	} catch (err) {
		throw new ForeignImportError(
			"unavailable",
			`foreign import failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const sessionFile = manager.getSessionFile();
	if (sessionFile === undefined) {
		throw new ForeignImportError("unavailable", "import produced no session file");
	}
	return {
		sessionId: manager.getSessionId(),
		sessionFile,
		provenance: {
			source: info.source,
			sourceName: foreignSessionSourceName(info.source),
			sourceId: info.id,
			sourcePath: info.path,
			sourceCwd: info.cwd,
			stagedUpload: false,
		},
	};
}

// ---------------------------------------------------------------------------
// Upload path: user-selected file bytes staged to temp, validated, imported
// ---------------------------------------------------------------------------

const EXEC_MAGIC_MZ = [0x4d, 0x5a];
const EXEC_MAGIC_ELF = [0x7f, 0x45, 0x4c, 0x46];

/** Size/type validation for uploaded transcripts (pure: safe to unit test). */
export function validateForeignUpload(data: Uint8Array, filename: string): void {
	if (data.length === 0) {
		throw new ForeignImportError("invalid_request", "uploaded file is empty");
	}
	if (data.length > FOREIGN_UPLOAD_MAX_BYTES) {
		throw new ForeignImportError(
			"invalid_request",
			`uploaded file exceeds the ${FOREIGN_UPLOAD_MAX_BYTES / 1024 / 1024} MiB import cap`,
		);
	}
	const ext = path.extname(filename).toLowerCase();
	if (FOREIGN_UPLOAD_EXTENSIONS[ext] !== true) {
		throw new ForeignImportError(
			"invalid_request",
			`unsupported upload type "${ext || "(none)"}": expected .jsonl or .json`,
		);
	}
	const isMagic = (magic: number[]): boolean =>
		data.length >= magic.length && magic.every((b, i) => data[i] === b);
	if (isMagic(EXEC_MAGIC_MZ) || isMagic(EXEC_MAGIC_ELF)) {
		throw new ForeignImportError("invalid_request", "executable files cannot be imported");
	}
	try {
		const body = new TextDecoder("utf-8", { fatal: true }).decode(data).trim();
		let records: unknown[];
		try {
			const parsed: unknown = JSON.parse(body);
			records = Array.isArray(parsed) ? parsed : [parsed];
		} catch {
			records = body
				.split(/\r?\n/)
				.filter((line) => line.trim() !== "")
				.map((line) => JSON.parse(line));
		}
		if (
			records.length === 0 ||
			records.some((value) => typeof value !== "object" || value === null || Array.isArray(value))
		) {
			throw new Error("not records");
		}
	} catch {
		throw new ForeignImportError("invalid_request", "uploaded file is not a JSON/JSONL transcript");
	}
}

function sanitizeUploadBasename(filename: string): string {
	const base = path
		.basename(filename)
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return base.length > 0 ? base.slice(0, 80) : "upload.jsonl";
}

export interface StagedForeignUpload {
	stagedId: string;
	stagedPath: string;
	filename: string;
	source: ForeignSessionSource;
	size: number;
	info: ForeignSessionInfo;
}

/**
 * Stage validated upload bytes to a private temp file (mode 0600).
 * The caller MUST remove the staging dir (rm recursive) after import or
 * cancel — {@link importUploadedForeignSession} does this automatically.
 */
export async function stageForeignUpload(
	source: ForeignSessionSource,
	data: Uint8Array,
	filename: string,
	tmpRoot?: string,
): Promise<StagedForeignUpload> {
	assertSource(source);
	validateForeignUpload(data, filename);
	const dir = await mkdtemp(path.join(tmpRoot ?? os.tmpdir(), "omp-foreign-import-"));
	try {
		const transcriptDir =
			source === "claude" ? path.join(dir, "projects", "upload") : path.join(dir, "sessions");
		await mkdir(transcriptDir, { recursive: true });
		const originalName = path.basename(filename.replace(/\\/g, "/"));
		const basename = sanitizeUploadBasename(originalName).replace(/\.(jsonl|json)$/i, "");
		const stagedPath = path.join(transcriptDir, `${basename}.jsonl`);
		await writeFile(stagedPath, data, { mode: 0o600 });
		const store = storeFor(source, dir);
		const listed = (await store.list()).find((info) => info.path === stagedPath);
		if (!listed)
			throw new ForeignImportError("invalid_request", "upload has no source session metadata");
		const manager = await store.load(listed);
		const entries = manager.getEntries();
		const messages = entries.filter((entry) => entry.type === "message");
		if (messages.length === 0)
			throw new ForeignImportError("invalid_request", "upload has no importable messages");
		const timestamps = messages
			.map((entry) => new Date(entry.timestamp).getTime())
			.filter(Number.isFinite);
		const firstUser = messages.find((entry) => entry.message.role === "user");
		const firstContent =
			firstUser && firstUser.message.role === "user" ? firstUser.message.content : undefined;
		const firstMessage =
			typeof firstContent === "string"
				? firstContent
				: Array.isArray(firstContent)
					? firstContent
							.filter(
								(part) =>
									typeof part === "object" &&
									part !== null &&
									"type" in part &&
									part.type === "text",
							)
							.map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
							.join("\n")
					: undefined;
		const info: ForeignSessionInfo = {
			...listed,
			path: originalName,
			cwd: manager.getCwd(),
			title: manager.getSessionName() ?? listed.title,
			created:
				timestamps.length > 0
					? new Date(timestamps.reduce((earliest, timestamp) => Math.min(earliest, timestamp)))
					: listed.created,
			modified:
				timestamps.length > 0
					? new Date(timestamps.reduce((latest, timestamp) => Math.max(latest, timestamp)))
					: listed.modified,
			messageCount: messages.length,
			firstMessage,
		};
		return {
			stagedId: `upload-${randomUUID()}`,
			stagedPath,
			filename: originalName,
			source,
			size: data.length,
			info,
		};
	} catch (error) {
		await rm(dir, { recursive: true, force: true });
		throw error;
	}
}

function uploadDirectory(upload: StagedForeignUpload): string {
	return upload.source === "claude"
		? path.dirname(path.dirname(path.dirname(upload.stagedPath)))
		: path.dirname(path.dirname(upload.stagedPath));
}

async function importStagedUpload(
	upload: StagedForeignUpload,
	options?: { sessionDir?: string; fallbackCwd?: string },
): Promise<ImportedForeignSession> {
	await assertImportableFile({ ...upload.info, path: upload.stagedPath });
	const sourceStore = storeFor(upload.source, uploadDirectory(upload));
	// The SDK writes provenance from info, while loading reads the private staged
	// path. Keeping these separate prevents temporary identities leaking on disk.
	const store: ForeignSessionStore = {
		source: upload.source,
		list: () => Promise.resolve([upload.info]),
		load: (info) => sourceStore.load({ ...info, path: upload.stagedPath }),
	};
	const imported = await persistForeignSession(store, upload.info, options);
	const sessionFile = imported.getSessionFile();
	if (!sessionFile) throw new ForeignImportError("unavailable", "import produced no session file");
	return {
		sessionId: imported.getSessionId(),
		sessionFile,
		provenance: {
			source: upload.source,
			sourceName: foreignSessionSourceName(upload.source),
			sourceId: upload.info.id,
			sourcePath: upload.info.path,
			sourceCwd: upload.info.cwd,
			stagedUpload: true,
		},
	};
}

/**
 * Full upload flow: validate -> stage -> load/convert -> persist under a new
 * native identity -> remove the staging dir. The foreign bytes live only in
 * the temp stage; nothing outside the sessions dir is touched.
 */
export async function importUploadedForeignSession(
	source: ForeignSessionSource,
	data: Uint8Array,
	filename: string,
	options?: { sessionDir?: string; fallbackCwd?: string; tmpRoot?: string },
): Promise<ImportedForeignSession> {
	assertSource(source);
	const staged = await stageForeignUpload(source, data, filename, options?.tmpRoot);
	try {
		return await importStagedUpload(staged, options);
	} finally {
		await rm(uploadDirectory(staged), { recursive: true, force: true }).catch(() => {});
	}
}

// ---------------------------------------------------------------------------
// Lineage-aware resume (verified materialization only)
// ---------------------------------------------------------------------------

/** Copy shown wherever a deleted-workspace resume is offered. */
export const DELETED_WORKSPACE_UNCOMMITTED_WARNING =
	"The original workspace was deleted. Uncommitted files are unrecoverable — " +
	"only the stored transcript can resume, onto a fresh clone at the pinned commit.";

export type ResumeLineageResult =
	| { kind: "ready"; sessionFile: string; warmed: boolean; files?: number; bytes?: number }
	| {
			kind: "refused";
			reason: "deleted-workspace" | "unavailable" | "invalid_request";
			message: string;
			resumeClonePath?: string;
			warning?: string;
	  };

export interface ResumeLineageDeps {
	sessionsDir: string;
	/** Cold fill via the daemon's callback pair (methods.ts materializeSession). */
	materialize?: (
		sessionId: string,
	) => Promise<{ files: number; bytes: number } | { alreadyPresent: true }>;
	/** Fleet registry liveness probe (injected so this module never imports fleet). */
	isWorkspaceLive?: (workspaceId: string) => boolean;
	resumeClonePathFor?: (workspaceId: string) => string | null;
}

/**
 * Verify-then-resume: warm trees resolve via `resolveSessionMainFile`;
 * cold trees materialize via the callback pair and re-verify (a transfer
 * that yields no main file is `unavailable`, never a silent fresh start).
 * Deleted workspaces refuse with the explicit resume-onto-fresh-clone path
 * (the fleet resume-clone route owns that mutation) plus the uncommitted-
 * file warning. Read-only stored browsing never reaches here, so it can
 * never wake compute through this path.
 */
export async function resumeWithLineage(
	sessionId: string,
	options: { workspaceId?: string; materializeIfCold?: boolean },
	deps: ResumeLineageDeps,
): Promise<ResumeLineageResult> {
	if (!SESSION_ID_RE.test(sessionId)) {
		return {
			kind: "refused",
			reason: "invalid_request",
			message: `unsafe sessionId: ${sessionId}`,
		};
	}
	if (options.workspaceId !== undefined && deps.isWorkspaceLive === undefined) {
		return {
			kind: "refused",
			reason: "unavailable",
			message: "workspace liveness probe is unavailable",
		};
	}
	if (
		options.workspaceId !== undefined &&
		deps.isWorkspaceLive !== undefined &&
		!deps.isWorkspaceLive(options.workspaceId)
	) {
		const resumeClonePath = deps.resumeClonePathFor?.(options.workspaceId) ?? undefined;
		return {
			kind: "refused",
			reason: "deleted-workspace",
			message: `workspace ${options.workspaceId} is deleted; resume onto a fresh clone instead`,
			...(resumeClonePath !== undefined ? { resumeClonePath } : {}),
			warning: DELETED_WORKSPACE_UNCOMMITTED_WARNING,
		};
	}
	if (sessionTreeExists(deps.sessionsDir, sessionId)) {
		const mainFile = resolveSessionMainFile(deps.sessionsDir, sessionId);
		if (mainFile !== null) return { kind: "ready", sessionFile: mainFile, warmed: true };
		return {
			kind: "refused",
			reason: "unavailable",
			message: `session ${sessionId} has local artifacts but no main transcript`,
		};
	}
	if (options.materializeIfCold === false || deps.materialize === undefined) {
		return {
			kind: "refused",
			reason: "unavailable",
			message: `session ${sessionId} is not materialized on this workspace (no callback pair active)`,
		};
	}
	let outcome: { files: number; bytes: number } | { alreadyPresent: true };
	try {
		outcome = await deps.materialize(sessionId);
	} catch (err) {
		return {
			kind: "refused",
			reason: "unavailable",
			message: `materialization failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	const mainFile = resolveSessionMainFile(deps.sessionsDir, sessionId);
	if (mainFile === null) {
		return {
			kind: "refused",
			reason: "unavailable",
			message: `session ${sessionId} has no transcript on this workspace or in the fleet store`,
		};
	}
	return {
		kind: "ready",
		sessionFile: mainFile,
		warmed: "alreadyPresent" in outcome,
		...("files" in outcome ? { files: outcome.files, bytes: outcome.bytes } : {}),
	};
}

// ---------------------------------------------------------------------------
// P0 method binder (single integration point; no methods.ts edits here)
// ---------------------------------------------------------------------------

export interface ResumeImportContext extends ResumeQuery {
	/** Extra daemon-configured data roots, scoped by foreign source. */
	authorizedForeignRoots?: Partial<Record<ForeignSessionSource, readonly string[]>>;
	materialize?: ResumeLineageDeps["materialize"];
	isWorkspaceLive?: ResumeLineageDeps["isWorkspaceLive"];
	resumeClonePathFor?: ResumeLineageDeps["resumeClonePathFor"];
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

/**
 * Build the daemon `call` handlers P0 publishes. Each handler takes the raw
 * `args` array and returns JSON-safe values; throws carry typed
 * invalid_request/unavailable messages to the caller (duplicate call ids
 * replay the recorded answer via the existing dedup window — no new
 * transport here).
 */
export function createResumeImportHandlers(
	ctx: ResumeImportContext,
): Record<string, (args: unknown[]) => Promise<unknown>> {
	const sessionsDir = resolveSessionDir(ctx);
	const lineageDeps: ResumeLineageDeps = {
		sessionsDir,
		...(ctx.materialize ? { materialize: ctx.materialize } : {}),
		...(ctx.isWorkspaceLive ? { isWorkspaceLive: ctx.isWorkspaceLive } : {}),
		...(ctx.resumeClonePathFor ? { resumeClonePathFor: ctx.resumeClonePathFor } : {}),
	};
	// Staged uploads awaiting confirm/cancel (stagedId -> StagedForeignUpload).
	const staged = new Map<string, StagedForeignUpload>();
	const selections = new Map<
		ForeignSessionSource,
		Map<string, { store: ForeignSessionStore; info: ForeignSessionInfo }>
	>();
	async function listAuthorized(
		source: ForeignSessionSource,
		requestedRoot?: string,
	): Promise<ForeignSessionPreview[]> {
		const defaultRoot =
			source === "claude" ? resolveClaudePaths().configDir : path.join(os.homedir(), ".codex");
		const root = path.resolve(requestedRoot ?? defaultRoot);
		if (
			requestedRoot !== undefined &&
			(!path.isAbsolute(requestedRoot) ||
				![defaultRoot, ...(ctx.authorizedForeignRoots?.[source] ?? [])].some((allowed) =>
					isWithin(path.resolve(allowed), root),
				))
		) {
			throw new ForeignImportError(
				"invalid_request",
				"foreign root is outside the authorized source scope",
			);
		}
		if (requestedRoot !== undefined) await resolveAuthorizedRoot(root);
		const store = storeFor(source, root);
		const rows = new Map<string, { store: ForeignSessionStore; info: ForeignSessionInfo }>();
		for (const info of await store.list()) {
			if (!isWithin(root, info.path))
				throw new ForeignImportError(
					"invalid_request",
					"foreign session is outside its authorized root",
				);
			await assertImportableFile(info);
			if (rows.has(info.id))
				throw new ForeignImportError(
					"invalid_request",
					"foreign source has ambiguous session identities",
				);
			rows.set(info.id, { store, info });
		}
		selections.set(source, rows);
		return [...rows.values()].map(({ info }) => foreignPreviewOf(info));
	}
	async function selected(source: ForeignSessionSource, id: string) {
		if (!selections.has(source)) await listAuthorized(source);
		const selection = selections.get(source)?.get(id);
		if (!selection) throw new ForeignImportError("unavailable", `foreign session not found: ${id}`);
		await assertImportableFile(selection.info);
		return selection;
	}
	return {
		getResumeCapabilities: async () => ({
			resolve: { available: true } satisfies ResumeCapability,
			pins: { available: true } satisfies ResumeCapability,
			foreignImport: { available: true } satisfies ResumeCapability,
			lineage: (ctx.materialize
				? { available: true }
				: {
						available: true,
						reason: "cold sessions unavailable: no callback pair active",
					}) satisfies ResumeCapability,
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
				agentDir: ctx.agentDir,
				...(query !== undefined ? { query } : {}),
				...(limit !== undefined ? { limit } : {}),
			});
		},
		resumePinToggle: async (args) => {
			const obj = argAt(args, 0);
			const sessionId = strField(obj, "sessionId") ?? "";
			return toggleResumePin(sessionId, ctx.agentDir);
		},
		foreignList: async (args) => {
			const obj = argAt(args, 0);
			const source = strField(obj, "source") ?? "";
			assertSource(source);
			const root = strField(obj, "root");
			return {
				source,
				sessions: await listAuthorized(source, root),
			};
		},
		foreignPreview: async (args) => {
			const obj = argAt(args, 0);
			const source = strField(obj, "source") ?? "";
			assertSource(source);
			const id = strField(obj, "id") ?? "";
			const upload = staged.get(id);
			if (upload?.source === source) {
				await assertImportableFile({ ...upload.info, path: upload.stagedPath });
				return { ...foreignPreviewOf(upload.info), id, staged: true };
			}
			const { store, info } = await selected(source, id);
			return previewForeignSession(store, info);
		},
		foreignImport: async (args) => {
			const obj = argAt(args, 0);
			const source = strField(obj, "source") ?? "";
			assertSource(source);
			const id = strField(obj, "id") ?? "";
			const fallbackCwd = strField(obj, "fallbackCwd");
			const pending = staged.get(id);
			if (pending && pending.source === source) {
				try {
					return await importStagedUpload(pending, {
						sessionDir: ctx.sessionDir,
						...(fallbackCwd !== undefined ? { fallbackCwd } : {}),
					});
				} finally {
					staged.delete(id);
					await rm(uploadDirectory(pending), { recursive: true, force: true }).catch(() => {});
				}
			}
			const { store, info } = await selected(source, id);
			return importForeignSession(store, info, {
				sessionDir: ctx.sessionDir,
				...(fallbackCwd !== undefined ? { fallbackCwd } : {}),
			});
		},
		foreignUploadStage: async (args) => {
			const obj = argAt(args, 0);
			const source = strField(obj, "source") ?? "";
			assertSource(source);
			const filename = strField(obj, "filename") ?? "upload.jsonl";
			const bytesBase64 = strField(obj, "bytesBase64") ?? "";
			let data: Uint8Array;
			try {
				data = Buffer.from(bytesBase64, "base64");
			} catch {
				throw new ForeignImportError("invalid_request", "upload bytes are not valid base64");
			}
			if (data.length === 0 && bytesBase64.length > 0) {
				throw new ForeignImportError("invalid_request", "upload bytes are not valid base64");
			}
			const upload = await stageForeignUpload(source, data, filename);
			staged.set(upload.stagedId, upload);
			return {
				stagedId: upload.stagedId,
				preview: {
					...foreignPreviewOf(upload.info),
					id: upload.stagedId,
					staged: true,
				} satisfies ForeignSessionPreview,
			};
		},
		foreignUploadCancel: async (args) => {
			const obj = argAt(args, 0);
			const stagedId = strField(obj, "stagedId") ?? "";
			const pending = staged.get(stagedId);
			if (pending) {
				staged.delete(stagedId);
				await rm(uploadDirectory(pending), { recursive: true, force: true }).catch(() => {});
			}
			return { cancelled: true };
		},
		lineageResume: async (args) => {
			const obj = argAt(args, 0);
			const sessionId = strField(obj, "sessionId") ?? "";
			const workspaceId = strField(obj, "workspaceId");
			const materializeIfCold =
				typeof obj.materializeIfCold === "boolean" ? obj.materializeIfCold : undefined;
			return resumeWithLineage(
				sessionId,
				{
					...(workspaceId !== undefined ? { workspaceId } : {}),
					...(materializeIfCold !== undefined ? { materializeIfCold } : {}),
				},
				lineageDeps,
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
