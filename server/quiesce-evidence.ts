import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { callbackError, QUIESCE_EVIDENCE_MAX_BYTES } from "../shared/callback-protocol";
import type { CloneGitEvidence, FlushBoundary, QuiesceEvidence } from "../shared/callback-protocol";
import type { ManifestFile, ManifestFileKind } from "../shared/archive-manifest";
import { planSessionExport, verifyJsonlStructure } from "../runtime/export-sessions";
import type { SessionExportPlan } from "../runtime/export-sessions";
import type { SessionLogTailer } from "./log-tailer";

/**
 * Daemon-side quiesce evidence helpers (P4.5/P3.5). All functions are
 * synchronous I/O on the canonical agent sessions tree — invoked only after
 * the writer admission barrier is up and the session cascade is disposed, so
 * no writer can mutate the tree mid-verification. Git evidence lives in
 * ./git-preservation.
 */

/** Stat + sha256 one lineage file for the manifest. */
export function manifestFileFor(
	sessionsDir: string,
	relToSessions: string,
	kind: ManifestFileKind,
	sessionId: string,
	parentPath?: string,
): ManifestFile {
	const absolute = join(sessionsDir, relToSessions);
	const st = statSync(absolute);
	if (!st.isFile()) {
		throw callbackError("invalid_request", `lineage path is not a regular file: ${relToSessions}`, {
			detail: absolute,
		});
	}
	return {
		path: relToSessions,
		size: st.size,
		sha256: hashFile(absolute),
		kind,
		sessionId,
		...(parentPath !== undefined ? { parentPath } : {}),
	};
}

function hashFile(absolute: string): string {
	const hash = createHash("sha256");
	const fd = openSync(absolute, "r");
	const buf = Buffer.allocUnsafe(256 * 1024);
	try {
		for (;;) {
			const got = readSync(fd, buf, 0, buf.length, null);
			if (got <= 0) break;
			hash.update(buf.subarray(0, got));
		}
	} finally {
		closeSync(fd);
	}
	return hash.digest("hex");
}

/** Enumerate every lineage file under the sessions root and produce manifest entries. */
export function enumerateLineageManifest(sessionsDir: string): ManifestFile[] {
	const plan = planSessionExport(sessionsDir);
	return plan.files
		.map((file) =>
			manifestFileFor(sessionsDir, file.relToSessions, file.kind, file.sessionId, file.parentPath),
		)
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Structural verification of every declared JSONL: title slot + header +
 * newline-terminated entries, hard-blocking the SDK indeterminate-persistence
 * fingerprint (the P0.3 load-bearing predicate). Any failure is a typed
 * unavailable error (ExportError carries a ledger code).
 */
export function verifyLineageStructure(sessionsDir: string): void {
	const plan = planSessionExport(sessionsDir);
	for (const file of plan.files) {
		if (!file.relToSessions.endsWith(".jsonl")) continue;
		verifyJsonlStructure(join(sessionsDir, file.relToSessions), file.sessionId);
	}
}

/**
 * Finalize the log tailer for quiesce: freeze discovery, release torn tails
 * verbatim, emit per-stream eof, then snapshot the final flush boundary.
 * The fleet must reach exactly this boundary before the delete gate passes.
 */
export function finalizeTailerBoundary(tailer: SessionLogTailer): FlushBoundary {
	const boundary: FlushBoundary = {};
	for (const [streamId, entry] of tailer.finalizeForQuiesce()) {
		if (entry.eof)
			boundary[streamId] = { offset: entry.offset, generation: entry.generation, eof: true };
	}
	// Streams whose eof emission failed are NOT in the boundary — the caller
	// must treat a boundary that does not cover every tracked stream as an
	// explicit failure.
	const status = tailer.status();
	for (const session of status.sessions) {
		for (const stream of session.streams) {
			if (boundary[stream.streamId] === undefined) {
				throw callbackError("unavailable", `stream not finalized for quiesce: ${stream.streamId}`);
			}
		}
	}
	return boundary;
}

/**
 * True when the acked-offset map covers every stream of `boundary` at or
 * beyond its final offset (fleet durability confirmed for the whole boundary).
 */
export function boundaryAcked(
	boundary: FlushBoundary,
	acked: ReadonlyMap<string, number>,
): boolean {
	for (const [streamId, want] of Object.entries(boundary)) {
		const have = acked.get(streamId);
		if (have === undefined || have < want.offset) return false;
	}
	return true;
}

// ── Quiesce evidence document (P3.5) ────────────────────────────────────────

/** Inputs for the single JSON document uploaded over the bulk channel. */
export interface QuiesceEvidenceParts {
	requestId: string;
	/** POSIX relpath of the main transcript; null only when none exists anywhere. */
	mainSessionRelpath: string | null;
	boundary: FlushBoundary;
	manifestFiles: ManifestFile[];
	provenance: QuiesceEvidence["provenance"];
	writers: QuiesceEvidence["writers"];
	git: CloneGitEvidence;
}

/**
 * Assemble and serialize the evidence document, enforcing the document bound
 * (16 MiB), which is itself below the bulk channel's 64 MiB cap. A document
 * over the bound is a typed invalid_request, never a truncated upload.
 */
export function serializeQuiesceEvidence(parts: QuiesceEvidenceParts): string {
	const evidence: QuiesceEvidence = { ...parts };
	const document = JSON.stringify(evidence);
	const bytes = Buffer.byteLength(document, "utf8");
	if (bytes > QUIESCE_EVIDENCE_MAX_BYTES) {
		throw callbackError(
			"invalid_request",
			`quiesce evidence is ${bytes} bytes, over the ${QUIESCE_EVIDENCE_MAX_BYTES}-byte document bound (bulk cap is 64 MiB)`,
		);
	}
	return document;
}

/**
 * POSIX relpath of the boot main transcript under the agent sessions dir, or
 * null only when the volume holds no main transcript at all. `mainSessionFile`
 * is the boot session's absolute file (null before it is known); when it names
 * a declared main that path wins, otherwise the planner's single/lowest-sorted
 * main is used so a materialized main is never reported as absent.
 */
export function mainSessionRelpathFor(
	sessionsDir: string,
	mainSessionFile: string | null,
): string | null {
	let plan: SessionExportPlan;
	try {
		plan = planSessionExport(sessionsDir);
	} catch {
		return null;
	}
	const mains = [...plan.mainSessions.keys()].sort();
	if (mains.length === 0) return null;
	if (mainSessionFile !== null) {
		const rel = relative(sessionsDir, mainSessionFile);
		const normalized = rel.split(sep).join("/");
		if (!rel.startsWith("..") && !rel.startsWith(sep) && plan.mainSessions.has(normalized)) {
			return normalized;
		}
	}
	return mains[0]!;
}
