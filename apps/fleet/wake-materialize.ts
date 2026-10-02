/**
 * Fleet-side wake materialization (P8.9/P8.10; docs/clone-contracts.md
 * "Wake" and "Fleet log store").
 *
 * When a clone workspace wakes and the resume-target session's transcript
 * is cold or missing in the volume agent dir, the FLEET fills the missing
 * stored lineage files from its log store into the volume's sessions dir
 * BEFORE the daemon spawns with the resume hint. This is the fleet-local
 * (bwrap) counterpart of the daemon-side bulk materialization
 * (server/session-materialize.ts, which rides the callback pair and covers
 * LIVE daemons); it also powers resume-onto-fresh-clone for deleted
 * workspaces (fleet/server.ts #handleResumeClone) on a fresh volume.
 *
 * Layout contract (mirrors server/log-tailer.ts discovery and
 * runtime/export-sessions.ts): the fleet store mirrors the agent sessions
 * root byte-for-byte under logs/<workspaceId>/<sessionId>/<relpath>, where
 * <sessionId> is the slash-free lineage key (main-file stem) and <relpath>
 * is POSIX-relative to the sessions root verbatim (main at depth 1
 * `<sessionId>.jsonl` or depth 2 `<proj>/<sessionId>.jsonl`, artifacts
 * under the sibling stem dir). Materialization writes each stored file to
 * `<sessionsDir>/<relpath>`.
 *
 * Fill-missing-only rule: the store may LAG the volume (a stop can leave an
 * unacknowledged tail on the volume that never streamed). This helper never
 * overwrites an existing local file; the volume is the fresher truth and
 * the daemon's tailer re-streams any local tail once booted. Only truly
 * cold/missing files are filled from the store.
 *
 * Safety: every relpath is validated with the frozen manifest predicate
 * (isNormalizedPosixRelativePath: no `..`, no absolute, no `.` segments)
 * and the resolved target must stay inside the sessions dir (isPathUnder,
 * the fleet-side convention shared with the resume-clone route) before any
 * file is opened. A hostile stored relpath aborts the whole fill.
 *
 * Typed failures reuse the frozen vocabulary only: `unavailable` when the
 * store lacks the session or IO fails; `invalid_request` for malformed ids
 * or hostile relpaths. No new error names.
 */

import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { isNormalizedPosixRelativePath } from "../../lib/session-files/archive-manifest";
import { isPathUnder } from "./worktrees";

export type WakeMaterializeErrorCode = "invalid_request" | "unavailable";

export class WakeMaterializeError extends Error {
	constructor(
		readonly code: WakeMaterializeErrorCode,
		message: string,
		readonly relpath?: string,
	) {
		super(message);
		this.name = "WakeMaterializeError";
	}
}

/** Structural subset of the store's read surface (never imports log-store). */
export interface WakeMaterializeStore {
	storedLineage(
		workspaceId: string,
		sessionId: string,
	): {
		sessionId: string;
		files: Array<{
			relpath: string;
			status: "stored" | "missing";
		}>;
		mainRelpath?: string;
	} | null;
	readStored(workspaceId: string, sessionId: string, relpath: string): Buffer | null;
	listStoredSessions?(workspaceId: string): Array<{ sessionId: string; mtimeMs: number }>;
}

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function invalid(message: string, relpath?: string): WakeMaterializeError {
	return new WakeMaterializeError("invalid_request", message, relpath);
}

function assertSessionId(sessionId: string): void {
	if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
		throw invalid(`unsafe sessionId: ${JSON.stringify(sessionId)}`);
	}
}

function requireSessionsDir(sessionsDir: string): void {
	if (typeof sessionsDir !== "string" || sessionsDir.length === 0 || !isAbsolute(sessionsDir)) {
		throw invalid("requires an absolute sessions dir");
	}
}

/** True when `<sessionsDir>/<relpath>` already exists as a file. */
function localFileExists(sessionsDir: string, relpath: string): boolean {
	try {
		return statSync(join(sessionsDir, relpath)).isFile();
	} catch {
		return false;
	}
}

export interface MaterializeSessionOutcome {
	/** Files written from the store (0 when the tree was already warm). */
	written: number;
	/** Bytes written. */
	bytes: number;
	/** True when the session's main file is present after the fill. */
	mainPresent: boolean;
}

/**
 * Fill cold/missing stored lineage files of one session into the volume
 * sessions dir. Never overwrites an existing local file. Returns the write
 * counts and whether the main file is present. Throws WakeMaterializeError
 * for an unknown session (`unavailable`) or a hostile stored relpath
 * (`invalid_request`, aborting the fill).
 */
export function materializeMissingSessionFiles(opts: {
	store: WakeMaterializeStore;
	workspaceId: string;
	sessionId: string;
	sessionsDir: string;
}): MaterializeSessionOutcome {
	const { store, workspaceId, sessionId, sessionsDir } = opts;
	assertSessionId(workspaceId);
	assertSessionId(sessionId);
	requireSessionsDir(sessionsDir);
	const lineage = store.storedLineage(workspaceId, sessionId);
	if (lineage === null || lineage.files.length === 0) {
		throw new WakeMaterializeError(
			"unavailable",
			`no stored transcripts for session ${sessionId} in workspace ${workspaceId}`,
		);
	}
	mkdirSync(sessionsDir, { recursive: true });

	let written = 0;
	let bytes = 0;
	for (const file of lineage.files) {
		if (file.status !== "stored") continue; // Missing store-side: explicitly unavailable.
		const relpath = file.relpath;
		if (typeof relpath !== "string" || !isNormalizedPosixRelativePath(relpath)) {
			throw invalid(`stored relpath is not a safe normalized relative path: ${relpath}`, relpath);
		}
		const target = join(sessionsDir, relpath);
		if (!isPathUnder(target, sessionsDir)) {
			throw invalid(`stored relpath escapes the sessions dir: ${relpath}`, relpath);
		}
		if (localFileExists(sessionsDir, relpath)) continue; // Never clobber the volume.
		const data = store.readStored(workspaceId, sessionId, relpath);
		if (data === null) continue; // Vanished between lineage and read.
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, data);
		written += 1;
		bytes += data.length;
	}

	const mainPresent =
		lineage.mainRelpath !== undefined && localFileExists(sessionsDir, lineage.mainRelpath);
	return { written, bytes, mainPresent };
}

/**
 * Resolve the absolute main-session file of `sessionId` under a sessions
 * dir: `<sessionId>.jsonl` at depth 1 or `<proj>/<sessionId>.jsonl` at
 * depth 2 (the frozen layout; bounded scan, no traversal). Returns null
 * when the main file is cold/missing.
 */
export function resolveMainSessionFile(sessionsDir: string, sessionId: string): string | null {
	assertSessionId(sessionId);
	requireSessionsDir(sessionsDir);
	const probe = (dir: string): string | null => {
		const candidate = join(dir, `${sessionId}.jsonl`);
		try {
			return statSync(candidate).isFile() ? candidate : null;
		} catch {
			return null;
		}
	};
	const root = probe(sessionsDir);
	if (root !== null) return root;
	let entries: string[];
	try {
		entries = readdirSync(sessionsDir);
	} catch {
		return null;
	}
	for (const name of entries) {
		const child = join(sessionsDir, name);
		let st;
		try {
			st = statSync(child);
		} catch {
			continue;
		}
		if (!st.isDirectory()) continue;
		const found = probe(child);
		if (found !== null) return found;
	}
	return null;
}

/**
 * Pick the newest session id for an implicit wake: the union of the volume
 * session tree (main files at depth ≤ 2, newest mtime) and the store
 * listing (when supplied), newest mtime wins. Returns undefined when no
 * session exists anywhere (the wake then boots fresh, correct for a
 * never-started clone).
 */
export function pickNewestSessionId(opts: {
	sessionsDir: string;
	store?: WakeMaterializeStore;
	workspaceId?: string;
}): string | undefined {
	const { sessionsDir, store, workspaceId } = opts;
	let best: { id: string; mtimeMs: number } | undefined;

	const consider = (id: string, mtimeMs: number): void => {
		if (best === undefined || mtimeMs > best.mtimeMs) best = { id, mtimeMs };
	};

	const scanDir = (dir: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			if (!name.endsWith(".jsonl")) continue;
			const stem = name.slice(0, -".jsonl".length);
			if (!SESSION_ID_RE.test(stem)) continue;
			try {
				consider(stem, statSync(join(dir, name)).mtimeMs);
			} catch {
				// Unreadable/raced entry: ignore.
			}
		}
	};
	scanDir(sessionsDir); // Depth 1: root mains.
	let rootDirs: string[];
	try {
		rootDirs = readdirSync(sessionsDir);
	} catch {
		rootDirs = [];
	}
	for (const name of rootDirs) {
		const child = join(sessionsDir, name);
		try {
			if (!statSync(child).isDirectory()) continue;
		} catch {
			continue;
		}
		scanDir(child); // Depth 2: project mains.
	}

	if (store !== undefined && workspaceId !== undefined && store.listStoredSessions !== undefined) {
		for (const session of store.listStoredSessions(workspaceId)) {
			consider(session.sessionId, session.mtimeMs);
		}
	}
	return best?.id;
}
