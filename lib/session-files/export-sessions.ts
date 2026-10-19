import {
	closeSync,
	lstatSync,
	openSync,
	readSync,
	readdirSync,
	realpathSync,
	statSync,
} from "node:fs";
import path from "node:path";
import { ExportError, type ManifestFileKind } from "./archive-manifest";

// ---------------------------------------------------------------------------
// Workspace session-tree planning + structural verification
// (lib/session-files/export-sessions.ts).
//
// Post-09-05-amendment role (docs/clone-contracts.md, docs/clone-plan.md P4.4-P4.6,
// P7.1-P7.2): the sealed export/archive-copy pipeline is DEAD. This module
// keeps only what the verify-at-deletion gate and the daemon's own quiesce
// path need:
//
// - planSessionExport walks the canonical workspace session directory
//   (`<workspaceRoot>/.home/agent/sessions` by default) and returns the full
//   declared set with lineage, WITHOUT copying anything: main JSONL at depth
//   1 (`<sessionId>.jsonl`) or depth 2 (`<proj>/<sessionId>.jsonl`); artifact
//   subtrees `<sessionId>/` / `<proj>/<sessionId>/` carrying subagent
//   transcripts, advisor recorders (`__advisor*.jsonl`), and metadata blobs.
//   Traversal is bounded (10k files / 16 GiB) and guarded on every entry:
//   symlinks, non-regular files, and realpath escapes are rejected; auth/
//   config/unrelated content is excluded, never walked.
// - verifyJsonlStructure is the load-bearing flush-evidence predicate (P0.3
//   finding): title slot + session header + newline-terminated entries with a
//   header id matching the session id, and NO partial tail; anything that
//   resembles the SDK's "persistence is indeterminate" condition is a hard
//   blocker. It tolerates no recovery; quiesced writers plus this structural
//   read is the ONLY supported flush acknowledgment (force-kill/process exit
//   is never evidence).
//
// All thrown errors are {@link ExportError} with a ledger code
// (`invalid_request` for unsafe paths/types, `unavailable` for I/O and
// indeterminate-persistence conditions).
// ---------------------------------------------------------------------------

export const JSONL_SUFFIX = ".jsonl";
export const ADVISOR_TRANSCRIPT_STEM = "__advisor";

/** Hard bounds from clone-plan P4.6 ("bound export traversal and transfer"). */
export const MAX_EXPORT_FILES = 10_000;
export const MAX_EXPORT_BYTES = 16 * 1024 * 1024 * 1024; // 16 GiB
const READ_BUFFER_BYTES = 256 * 1024;

function isJsonlName(name: string): boolean {
	return name.endsWith(JSONL_SUFFIX);
}

export function isAdvisorTranscriptName(name: string): boolean {
	return (
		name === `${ADVISOR_TRANSCRIPT_STEM}.jsonl` ||
		(name.startsWith(`${ADVISOR_TRANSCRIPT_STEM}.`) && name.endsWith(JSONL_SUFFIX))
	);
}

/**
 * Type guard: an unknown error that is already an {@link ExportError} (imported
 * type-only, so compare by shape/name at runtime).
 */
export function isExportErrorShape(error: unknown): error is ExportError {
	return error instanceof Error && (error as { name?: string }).name === "ExportError";
}

/**
 * Wrap an unexpected failure (ENOENT/EPERM/ENOSPC/JSON parse/EACCES) in a
 * ledger-coded `unavailable` ExportError with a human context prefix.
 */
export function asUnavailable(error: unknown, context: string, filePath?: string): ExportError {
	return new ExportError(
		"unavailable",
		`${context}: ${error instanceof Error ? error.message : String(error)}`,
		filePath,
	);
}

/**
 * True for a file whose byte content matches the SDK's "persistence is
 * indeterminate" fingerprint: a disk-failure artifact that must be treated as
 * a hard blocker rather than recovered into a best-effort export.
 */
export function isPersistenceIndeterminateFingerprint(firstLine: string): boolean {
	return /persistence.*indeterminate/i.test(firstLine);
}

const titleSlotLineShape = (value: Record<string, unknown>): boolean =>
	value.type === "title" &&
	value.v === 1 &&
	typeof value.title === "string" &&
	typeof value.updatedAt === "string" &&
	typeof value.pad === "string" &&
	(value.source === undefined || value.source === "auto" || value.source === "user");

const headerLineShape = (value: Record<string, unknown>): boolean => value.type === "session";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLine(line: string): unknown {
	return JSON.parse(line) as unknown;
}

/** Context tag on every structural-verification error. */
const STRUCTURE_CONTEXT = "session structural verification";

/**
 * Incremental form of the structural JSONL predicate (see verifyJsonlStructure).
 * Feed the file's bytes in order through `push`, then call `finish` once. It
 * throws the same ledger `unavailable` ExportErrors, in the same line order, as
 * the whole-file check, so a caller that streams a file while hashing it gets
 * the identical verdict without a second read.
 */
export interface JsonlStructureChecker {
	push(chunk: Uint8Array): void;
	finish(): void;
}

/**
 * Structural checker for one declared JSONL: title slot (or header, for legacy
 * files without a slot) on line 1, then a session header line, then
 * newline-terminated entries. Every line must be complete JSON and the file
 * must not end in a partial record. Never recovers.
 */
export function createJsonlStructureChecker(absolutePath: string): JsonlStructureChecker {
	const unavailable = (message: string): ExportError =>
		asUnavailable(new Error(message), STRUCTURE_CONTEXT, absolutePath);
	const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
	// Text after the last newline; an unterminated tail is a line only at finish().
	let partial = "";
	let lineCount = 0;
	// first: expecting the title slot or a legacy header; title: expecting the
	// header after a title slot; entries: header accepted, entries follow.
	let phase: "first" | "title" | "entries" = "first";

	const consume = (text: string, terminated: boolean): void => {
		lineCount += 1;
		if (phase === "entries") {
			if (text.length === 0 || !terminated) {
				throw unavailable(`incomplete entry on line ${lineCount} (truncated tail)`);
			}
			try {
				parseLine(text);
			} catch {
				throw unavailable(`malformed entry on line ${lineCount}`);
			}
			return;
		}
		let header: Record<string, unknown>;
		if (phase === "first") {
			if (isPersistenceIndeterminateFingerprint(text)) {
				throw unavailable("session persistence indeterminate artifact: hard blocker");
			}
			if (!terminated) throw unavailable("file ends inside the first record");
			let first: unknown;
			try {
				first = parseLine(text);
			} catch {
				throw unavailable("first line is not valid JSON");
			}
			if (isRecord(first) && titleSlotLineShape(first)) {
				// Modern layout: the session header is line 2 (even a fresh session
				// carries header + title slot).
				phase = "title";
				return;
			}
			if (!isRecord(first) || !headerLineShape(first)) {
				throw unavailable("first line is neither a title slot nor a session header");
			}
			// Legacy layout: no title slot; the header is the first line.
			header = first;
		} else {
			if (!terminated) throw unavailable("file ends before the session header");
			let parsed: unknown;
			try {
				parsed = parseLine(text);
			} catch {
				throw unavailable("header line is not valid JSON");
			}
			if (!isRecord(parsed) || !headerLineShape(parsed)) {
				throw unavailable("line after title slot is not a session header");
			}
			header = parsed;
		}
		if (typeof header.id !== "string" || header.id === "") {
			throw unavailable("session header has no id");
		}
		// NOTE: the header id is a minted session UUID that does NOT equal the
		// filename stem: the SDK names main files `<timestamp>_<id>.jsonl` and
		// fork files `<agentId>.jsonl`, so filename↔header-id equality is NOT an
		// invariant and is never asserted here. Lineage identity comes from the
		// file's path (which session dir / artifact subtree it lives under), not
		// from the header.
		phase = "entries";
	};

	return {
		push(chunk: Uint8Array): void {
			const text = decoder.decode(chunk, { stream: true });
			let start = 0;
			let newline = text.indexOf("\n");
			while (newline !== -1) {
				consume(partial + text.slice(start, newline), true);
				partial = "";
				start = newline + 1;
				newline = text.indexOf("\n", start);
			}
			partial += text.slice(start);
		},
		finish(): void {
			partial += decoder.decode();
			if (partial.length > 0) {
				const tail = partial;
				partial = "";
				consume(tail, false);
			}
			if (lineCount === 0) {
				throw unavailable("empty JSONL file");
			}
			if (phase === "title") {
				throw unavailable("file ends before the session header");
			}
		},
	};
}

/**
 * Structural read verification of one declared JSONL (P0.3 finding,
 * load-bearing); see createJsonlStructureChecker for the rules. Throws ledger
 * `unavailable`/`conflict` ExportErrors; never recovers.
 */
export function verifyJsonlStructure(absolutePath: string, sessionId: string): void {
	const checker = createJsonlStructureChecker(absolutePath);
	const fd = openSync(absolutePath, "r");
	try {
		const buffer = Buffer.alloc(READ_BUFFER_BYTES);
		for (;;) {
			const read = readSync(fd, buffer, 0, buffer.length, null);
			if (read <= 0) break;
			checker.push(buffer.subarray(0, read));
		}
	} finally {
		closeSync(fd);
	}
	checker.finish();
}

function isWithinReal(realPath: string, realRoot: string): boolean {
	if (realPath === realRoot) return true;
	const prefix = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`;
	return realPath.startsWith(prefix);
}

// ---------------------------------------------------------------------------
// Lineage classification (shared rule)
// ---------------------------------------------------------------------------

/**
 * One classified lineage entry: the manifest file shape minus hashing/bytes,
 * plus the owning-session id. `sessionId` is the LINEAGE KEY (the session-dir
 * / main-file stem) the file belongs to, not the SDK header UUID.
 */
export interface SessionLineageEntry {
	/** POSIX-relative path inside the session directory. */
	relToSessions: string;
	kind: ManifestFileKind;
	/** Owning lineage key (main-file stem, == session-dir name in the store). */
	sessionId: string;
	/** Main JSONL relpath owning this artifact (absent on the main file). */
	parentPath?: string;
}

/**
 * True when `relpath` names the main session file of lineage key
 * `sessionId`: `<sessionId>.jsonl` at depth 1 (root main) or
 * `<proj>/<sessionId>.jsonl` at depth 2 (project main), per the frozen
 * log-stream identity (`logs/<sessionId>/<relpath>`, relpath
 * sessions-root-relative verbatim: docs/clone-contracts.md, Main's ruling).
 */
export function isMainRelpath(relpath: string, sessionId: string): boolean {
	const segments = relpath.split("/");
	if (segments[segments.length - 1] !== `${sessionId}.jsonl`) return false;
	return segments.length === 1 || segments.length === 2;
}

/**
 * The nearest ancestor main whose stem dir prefixes `relpath` (longest stem
 * wins): the SDK nests artifacts under `<main>.jsonl`'s sibling stem dir
 * (`<main>.jsonl` ↔ `<main>/`), possibly under a `<proj>/` prefix.
 */
export function owningMainRel(relpath: string, mains: ReadonlySet<string>): string | undefined {
	let best: { len: number; main: string } | undefined;
	for (const mainRel of mains) {
		const stem = mainRel.endsWith(".jsonl") ? mainRel.slice(0, -".jsonl".length) : mainRel;
		if (relpath.startsWith(`${stem}/`) && (best === undefined || stem.length > best.len)) {
			best = { len: stem.length, main: mainRel };
		}
	}
	return best?.main;
}

function sessionIdOfMain(mainRel: string): string {
	return path.basename(mainRel).slice(0, -JSONL_SUFFIX.length);
}

/**
 * Classify one path against the declared main set: main files classify main;
 * anything else must nest under a declared main's stem dir (else the tree
 * has a file with no owning lineage, rejected). Nested `__advisor*.jsonl`
 * are advisor recorders, other `.jsonl` are subagent transcripts (each is
 * its OWN SDK session with its own header), everything else is metadata.
 */
export function classifyLineageEntry(
	relpath: string,
	mains: ReadonlySet<string>,
): Omit<SessionLineageEntry, "relToSessions"> {
	if (mains.has(relpath)) {
		return { kind: "main", sessionId: sessionIdOfMain(relpath) };
	}
	const parentRel = owningMainRel(relpath, mains);
	if (parentRel === undefined) {
		throw new ExportError(
			"invalid_request",
			`path is not part of a session lineage (no owning main): ${relpath}`,
			relpath,
		);
	}
	const name = path.basename(relpath);
	const kind: ManifestFileKind = isAdvisorTranscriptName(name)
		? "advisor"
		: isJsonlName(name)
			? "subagent"
			: "metadata";
	return { kind, sessionId: sessionIdOfMain(parentRel), parentPath: parentRel };
}

// ---------------------------------------------------------------------------
// Session tree planning
// ---------------------------------------------------------------------------

/** The export plan: every main session JSONL plus the files inside its artifact
 *  subtree, classified by kind, in the SDK layout (`<main>.jsonl` ↔ `<main>/`,
 *  or `<proj>/<main>.jsonl` ↔ `<proj>/<main>/`). */
export interface SessionExportPlan {
	/** Ordered by discovery; consumers sort for determinism. */
	files: SessionLineageEntry[];
	/** relToSessions → sessionId for every main session. */
	mainSessions: Map<string, string>;
}

/**
 * Enumerate the export set under the sessions root, applying the traversal
 * guards uniformly to every entry: symlinks rejected, non-regular files
 * rejected, realpath must stay inside the real sessions root. Only declared
 * main `*.jsonl` files and their artifact-dir subtrees are in scope; auth/
 * config/unrelated content (stray files, dirs without a matching main) is
 * excluded, never walked. Enforces the 10k-file and 16GiB bounds.
 *
 * This function is shared by the daemon's quiesce path and the fleet-store
 * verification gate; it never copies or stages anything.
 */
export function planSessionExport(sessionsDir: string): SessionExportPlan {
	const rootReal = realpathSync(sessionsDir);
	const files: SessionLineageEntry[] = [];
	const mainSessions = new Map<string, string>();
	let totalBytes = 0;
	let count = 0;

	const checkContained = (real: string, relToSessions: string): void => {
		if (!isWithinReal(real, rootReal)) {
			throw new ExportError(
				"invalid_request",
				`path escapes session directory: ${relToSessions}`,
				relToSessions,
			);
		}
	};
	const addFile = (entry: SessionLineageEntry): void => {
		if (count >= MAX_EXPORT_FILES) {
			throw new ExportError(
				"invalid_request",
				`export exceeds ${MAX_EXPORT_FILES} files`,
				entry.relToSessions,
			);
		}
		totalBytes += statSync(path.join(sessionsDir, entry.relToSessions)).size;
		if (totalBytes > MAX_EXPORT_BYTES) {
			throw new ExportError(
				"invalid_request",
				`export exceeds ${MAX_EXPORT_BYTES} bytes total`,
				entry.relToSessions,
			);
		}
		count += 1;
		files.push(entry);
	};
	const inspectEntry = (absolute: string, relToSessions: string): "dir" | "file" | "exclude" => {
		if (relToSessions === "" || relToSessions.startsWith("..") || path.isAbsolute(relToSessions)) {
			throw new ExportError(
				"invalid_request",
				`unsafe relative path: ${relToSessions}`,
				relToSessions,
			);
		}
		const info = lstatSync(absolute);
		if (info.isSymbolicLink()) {
			throw new ExportError("invalid_request", `symlink rejected: ${relToSessions}`, relToSessions);
		}
		if (!info.isFile() && !info.isDirectory()) {
			throw new ExportError(
				"invalid_request",
				`non-regular file rejected: ${relToSessions}`,
				relToSessions,
			);
		}
		checkContained(realpathSync(absolute), relToSessions);
		return info.isDirectory() ? "dir" : "file";
	};

	// First pass: root-level main session JSONL files, and remember every
	// root-level directory (potential artifact dir or project dir).
	const rootEntries = readdirSync(sessionsDir, { withFileTypes: true });
	const rootDirs = new Set<string>();
	for (const entry of rootEntries) {
		const absolute = path.join(sessionsDir, entry.name);
		const rel = path.relative(sessionsDir, absolute);
		const type = inspectEntry(absolute, rel);
		if (type === "dir") {
			rootDirs.add(entry.name);
			continue;
		}
		if (!isMainSessionName(entry.name)) {
			// Stray/root-level non-session file: unrelated content, excluded.
			continue;
		}
		const sessionId = entry.name.slice(0, -JSONL_SUFFIX.length);
		mainSessions.set(rel, sessionId);
		addFile({ relToSessions: rel, kind: "main", sessionId });
	}

	// Second pass: artifact dirs of declared mains. Depth-1: `<main>/` for a
	// root main; depth-2: `<proj>/<main>/` (and `<proj>/<main>.jsonl` mains).
	const stack: Array<{ dirAbs: string; mainRel: string }> = [];
	for (const dirName of rootDirs) {
		const rootMain = `${dirName}${JSONL_SUFFIX}`;
		if (mainSessions.has(rootMain)) {
			stack.push({ dirAbs: path.join(sessionsDir, dirName), mainRel: rootMain });
			continue;
		}
		// Project dir: its child JSONLs may be depth-2 mains. readdir order is
		// arbitrary, so every child is validated and every main declared FIRST;
		// only then can a `<proj>/<main>/` artifact dir be resolved (a dir is
		// an artifact dir only when its sibling main has been declared).
		const dirAbs = path.join(sessionsDir, dirName);
		const children = readdirSync(dirAbs, { withFileTypes: true }).map((child) => {
			const childAbs = path.join(dirAbs, child.name);
			const childRel = path.relative(sessionsDir, childAbs);
			return {
				name: child.name,
				abs: childAbs,
				rel: childRel,
				type: inspectEntry(childAbs, childRel),
			};
		});
		for (const child of children) {
			if (child.type !== "file" || !isMainSessionName(child.name)) continue;
			const sessionId = sessionIdOfMain(child.rel);
			mainSessions.set(child.rel, sessionId);
			addFile({ relToSessions: child.rel, kind: "main", sessionId });
		}
		for (const child of children) {
			if (child.type !== "dir" || !mainSessions.has(`${child.rel}${JSONL_SUFFIX}`)) continue;
			stack.push({ dirAbs: child.abs, mainRel: `${child.rel}${JSONL_SUFFIX}` });
		}
	}
	const mains = new Set(mainSessions.keys());
	while (stack.length > 0) {
		const { dirAbs, mainRel } = stack.pop()!;
		for (const child of readdirSync(dirAbs, { withFileTypes: true })) {
			const childAbs = path.join(dirAbs, child.name);
			const childRel = path.relative(sessionsDir, childAbs);
			const type = inspectEntry(childAbs, childRel);
			if (type === "dir") {
				stack.push({ dirAbs: childAbs, mainRel });
				continue;
			}
			const classified = classifyLineageEntry(childRel, mains);
			addFile({
				relToSessions: childRel,
				kind: classified.kind,
				sessionId: classified.sessionId,
				...(classified.parentPath !== undefined ? { parentPath: classified.parentPath } : {}),
			});
		}
	}

	return { files, mainSessions };
}

function isMainSessionName(name: string): boolean {
	return isJsonlName(name) && !isAdvisorTranscriptName(name);
}
