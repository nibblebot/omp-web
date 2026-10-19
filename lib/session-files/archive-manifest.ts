import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Archive export manifest (`manifest.v1.json`).
//
// Entries are POSIX-relative
// normalized paths, no `..`, no absolute, regular files only; entries carry
// path/size/sha256/kind/sessionId/parentPath; provenance carries projectId/
// workspaceId/workspaceName/source/resolvedCommit/generatedAt. The exportId is
// content-addressed: `ws_<workspaceId>_<sha256(canonical manifest)[:16]>`, so
// identical retries are idempotent and conflicting exports collide without a
// timestamp tiebreak.
//
// Typed error codes are fixed; everything archive/export related throws ExportError.
// ---------------------------------------------------------------------------

export type ManifestFileKind = "main" | "subagent" | "advisor" | "metadata";

/** Clone source shape from the workspace registry record (fleet-private). */
export interface ManifestSource {
	local?: string;
	remote?: string;
}

export interface ManifestProvenance {
	projectId: string;
	workspaceId: string;
	workspaceName: string;
	source?: ManifestSource;
	resolvedCommit: string;
	generatedAt: string;
}

export interface ManifestFile {
	path: string;
	size: number;
	sha256: string;
	kind: ManifestFileKind;
	sessionId: string;
	/** Path of the parent JSONL for lineage via artifact-dir nesting. */
	parentPath?: string;
}

export interface ArchiveManifest {
	provenance: ManifestProvenance;
	files: ManifestFile[];
}

/** Typed export error codes. */
export type ExportErrorCode =
	| "invalid_request"
	| "invalid_identity"
	| "unauthorized"
	| "forbidden"
	| "unavailable"
	| "conflict"
	| "generation_obsolete"
	| "writer_active"
	| "archive_pending"
	| "archive_conflict"
	| "provider_failed"
	| "retryable";

export class ExportError extends Error {
	readonly code: ExportErrorCode;
	/** POSIX-relative manifest path the error is about, when applicable. */
	readonly path?: string;

	constructor(code: ExportErrorCode, message: string, path?: string) {
		super(message);
		this.name = "ExportError";
		this.code = code;
		this.path = path;
	}
}

/**
 * True for a normalized POSIX-relative path: non-empty, not absolute, no
 * drive/UNC prefixes, and segments are neither empty nor `.` nor `..`
 * (rejects `//`, leading/trailing slashes, and any traversal).
 */
export function isNormalizedPosixRelativePath(value: string): boolean {
	if (value === "" || value.startsWith("/")) return false;
	if (/^[A-Za-z]:/.test(value) || value.includes("\\")) return false;
	for (const segment of value.split("/")) {
		if (segment === "" || segment === "." || segment === "..") return false;
	}
	return true;
}

/**
 * Deterministic JSON: object keys sorted recursively, insignificant
 * whitespace dropped, `undefined` properties skipped. This, not the
 * pretty-printed file bytes, is what exportId hashes.
 */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "null";
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
	}
	const keys = Object.keys(value)
		.filter((key) => (value as Record<string, unknown>)[key] !== undefined)
		.sort();
	const parts = keys.map(
		(key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
	);
	return `{${parts.join(",")}}`;
}

/**
 * Content-addressed export identity from the frozen contract:
 * `ws_<workspaceId>_<sha256(canonical manifest)[:16]>`. Identical manifests
 * yield identical ids, so retries are idempotent.
 */
export function computeExportId(manifest: ArchiveManifest): string {
	const digest = createHash("sha256").update(canonicalJson(manifest)).digest("hex");
	return `ws_${manifest.provenance.workspaceId}_${digest.slice(0, 16)}`;
}
