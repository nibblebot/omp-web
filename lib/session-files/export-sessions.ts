import path from "node:path";
import { ExportError, type ManifestFileKind } from "./archive-manifest";

// ---------------------------------------------------------------------------
// Workspace session-tree lineage + structural verification
// (lib/session-files/export-sessions.ts).
//
// Role after the 09-05 amendment: the sealed
// export/archive-copy pipeline is DEAD. This module
// keeps only the lineage classification and the structural JSONL checker that
// the verify-at-deletion gate (apps/fleet/verify-store.ts) and the archive
// manifest need:
//
// - classifyLineageEntry, isMainRelpath, and owningMainRel map a
//   store-relative path to its owning main session and kind.
// - createJsonlStructureChecker is the streaming structural predicate: title
//   slot + session header + newline-terminated entries with a header id
//   matching the session id, and NO partial tail. Anything that resembles the
//   SDK's "persistence is indeterminate" condition is a hard blocker. It
//   tolerates no recovery.
//
// All thrown errors are {@link ExportError} with a ledger code
// (`invalid_request` for unsafe paths/types, `unavailable` for I/O and
// indeterminate-persistence conditions).
// ---------------------------------------------------------------------------

export const JSONL_SUFFIX = ".jsonl";
export const ADVISOR_TRANSCRIPT_STEM = "__advisor";

/** Hard bounds that keep export traversal and transfer finite. */
export const MAX_EXPORT_FILES = 10_000;
export const MAX_EXPORT_BYTES = 16 * 1024 * 1024 * 1024; // 16 GiB

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
 * Incremental form of the structural JSONL predicate.
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
 * sessions-root-relative verbatim (Main's ruling).
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
