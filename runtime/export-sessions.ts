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
import { ExportError, type ManifestFileKind } from "../shared/archive-manifest";

// ---------------------------------------------------------------------------
// Workspace session-tree planning + structural verification
// (runtime/export-sessions.ts).
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

/** A physical line: text sans `\n`, plus whether it was newline-terminated. */
interface JsonlLine {
	text: string;
	terminated: boolean;
}

function parseJsonlLines(content: string): JsonlLine[] {
	const lines: JsonlLine[] = [];
	let start = 0;
	for (let index = 0; index < content.length; index++) {
		if (content.charCodeAt(index) !== 10) continue;
		lines.push({ text: content.slice(start, index), terminated: true });
		start = index + 1;
	}
	if (start < content.length) {
		lines.push({ text: content.slice(start), terminated: false });
	}
	return lines;
}

/**
 * Structural read verification of one declared JSONL (P0.3 finding,
 * load-bearing): title slot (or header, for legacy files without a slot) on
 * line 1, then a session header line, then newline-terminated entries. Every
 * line must be complete JSON and the file must not end in a partial record.
 * Throws ledger `unavailable`/`conflict` ExportErrors; never recovers.
 */
export function verifyJsonlStructure(absolutePath: string, sessionId: string): void {
	const lines = parseJsonlLines(readFileText(absolutePath));
	if (lines.length === 0) {
		throw asUnavailable(
			new Error("empty JSONL file"),
			"session structural verification",
			absolutePath,
		);
	}
	const fingerprint = lines[0]?.text ?? "";
	if (isPersistenceIndeterminateFingerprint(fingerprint)) {
		throw asUnavailable(
			new Error("session persistence indeterminate artifact: hard blocker"),
			"session structural verification",
			absolutePath,
		);
	}

	// A partial first line cannot be a well-formed session/title record.
	if (!(lines[0]?.terminated ?? false)) {
		throw asUnavailable(
			new Error("file ends inside the first record"),
			"session structural verification",
			absolutePath,
		);
	}

	// Track which line is the session header. A modern file puts the title slot
	// on line 1 and the header on line 2; a legacy file starts with the header.
	let headerIndex = -1;
	let current = 0;
	let first: unknown;
	try {
		first = parseLine(lines[current]?.text ?? "");
	} catch {
		throw asUnavailable(
			new Error("first line is not valid JSON"),
			"session structural verification",
			absolutePath,
		);
	}
	if (isRecord(first) && titleSlotLineShape(first)) {
		// Modern layout: title slot on line 1, session header on line 2 (even
		// a fresh session with no entries yet carries header + title slot).
		current = 1;
		if (current >= lines.length || !(lines[current]?.terminated ?? false)) {
			throw asUnavailable(
				new Error("file ends before the session header"),
				"session structural verification",
				absolutePath,
			);
		}
		let header: unknown;
		try {
			header = parseLine(lines[current]?.text ?? "");
		} catch {
			throw asUnavailable(
				new Error("header line is not valid JSON"),
				"session structural verification",
				absolutePath,
			);
		}
		if (!isRecord(header) || !headerLineShape(header)) {
			throw asUnavailable(
				new Error("line after title slot is not a session header"),
				"session structural verification",
				absolutePath,
			);
		}
		headerIndex = current;
		current += 1;
	} else if (isRecord(first) && headerLineShape(first)) {
		// Legacy layout: no title slot; the header is the first line.
		headerIndex = 0;
		current = 1;
	} else {
		throw asUnavailable(
			new Error("first line is neither a title slot nor a session header"),
			"session structural verification",
			absolutePath,
		);
	}

	const header = parseLine(lines[headerIndex]?.text ?? "");
	if (headerIndex < 0 || !isRecord(header) || !headerLineShape(header)) {
		throw asUnavailable(
			new Error("missing session header"),
			"session structural verification",
			absolutePath,
		);
	}
	if (typeof header.id !== "string" || header.id === "") {
		throw asUnavailable(
			new Error("session header has no id"),
			"session structural verification",
			absolutePath,
		);
	}
	// NOTE: the header id is a minted session UUID that does NOT equal the
	// filename stem: the SDK names main files `<timestamp>_<id>.jsonl` and
	// fork files `<agentId>.jsonl`, so filename↔header-id equality is NOT an
	// invariant and is never asserted here. Lineage identity comes from the
	// file's path (which session dir / artifact subtree it lives under), not
	// from the header.

	// Remaining lines are entries; each must be complete JSON on a
	// newline-terminated line. A partial (unterminated) tail fails: a
	// truncated file is exactly what this check exists to catch.
	for (let index = current; index < lines.length; index++) {
		const line = lines[index] ?? { text: "", terminated: false };
		if (line.text.length === 0 || !line.terminated) {
			throw asUnavailable(
				new Error(`incomplete entry on line ${index + 1} (truncated tail)`),
				"session structural verification",
				absolutePath,
			);
		}
		try {
			parseLine(line.text);
		} catch {
			throw asUnavailable(
				new Error(`malformed entry on line ${index + 1}`),
				"session structural verification",
				absolutePath,
			);
		}
	}
}

/** Read a UTF-8 text file's bytes as a string (whole-file; bounded by size checks upstream). */
function readFileText(filePath: string): string {
	const fd = openSync(filePath, "r");
	try {
		const chunks: Buffer[] = [];
		const buffer = Buffer.alloc(READ_BUFFER_BYTES);
		for (;;) {
			const read = readSync(fd, buffer, 0, buffer.length, null);
			if (read <= 0) break;
			chunks.push(Buffer.from(buffer.subarray(0, read)));
		}
		return Buffer.concat(chunks).toString("utf8");
	} finally {
		closeSync(fd);
	}
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
		// Project dir: its child JSONLs may be depth-2 mains.
		const dirAbs = path.join(sessionsDir, dirName);
		for (const child of readdirSync(dirAbs, { withFileTypes: true })) {
			const childAbs = path.join(dirAbs, child.name);
			const childRel = path.relative(sessionsDir, childAbs);
			const type = inspectEntry(childAbs, childRel);
			if (type === "file" && isMainSessionName(child.name)) {
				const sessionId = sessionIdOfMain(childRel);
				mainSessions.set(childRel, sessionId);
				addFile({ relToSessions: childRel, kind: "main", sessionId });
				continue;
			}
			if (type === "dir" && mainSessions.has(`${childRel}${JSONL_SUFFIX}`)) {
				stack.push({ dirAbs: childAbs, mainRel: `${childRel}${JSONL_SUFFIX}` });
			}
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
