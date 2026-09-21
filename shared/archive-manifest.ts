import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Archive export manifest (`manifest.v1.json`).
//
// Frozen by docs/clone-contracts.md ("Export manifest"): POSIX-relative
// normalized paths, no `..`, no absolute, regular files only; entries carry
// path/size/sha256/kind/sessionId/parentPath; provenance carries projectId/
// workspaceId/workspaceName/source/resolvedCommit/generatedAt. The exportId is
// content-addressed: `ws_<workspaceId>_<sha256(canonical manifest)[:16]>`, so
// identical retries are idempotent and conflicting exports collide without a
// timestamp tiebreak.
//
// Typed error codes are the frozen ledger vocabulary (docs/clone-contracts.md
// "Typed errors"); everything archive/export related throws ExportError.
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

/** Code set frozen in docs/clone-contracts.md "Typed errors". */
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

const FILE_KINDS: readonly ManifestFileKind[] = ["main", "subagent", "advisor", "metadata"];
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, field: string, where: string): string {
	const value = record[field];
	if (typeof value !== "string" || value === "") {
		throw new ExportError("invalid_request", `${where}: ${field} must be a non-empty string`);
	}
	return value;
}

function optionalString(
	record: Record<string, unknown>,
	field: string,
	where: string,
): string | undefined {
	const value = record[field];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value === "") {
		throw new ExportError(
			"invalid_request",
			`${where}: ${field} must be a non-empty string when present`,
		);
	}
	return value;
}

function validateProvenance(value: unknown): ManifestProvenance {
	if (!isPlainObject(value)) {
		throw new ExportError("invalid_request", "provenance must be an object");
	}
	const provenance: ManifestProvenance = {
		projectId: requireString(value, "projectId", "provenance"),
		workspaceId: requireString(value, "workspaceId", "provenance"),
		workspaceName: requireString(value, "workspaceName", "provenance"),
		resolvedCommit: requireString(value, "resolvedCommit", "provenance"),
		generatedAt: requireString(value, "generatedAt", "provenance"),
	};
	const source = value.source;
	if (source !== undefined) {
		if (!isPlainObject(source)) {
			throw new ExportError("invalid_request", "provenance.source must be an object when present");
		}
		provenance.source = {
			local: optionalString(source, "local", "provenance.source"),
			remote: optionalString(source, "remote", "provenance.source"),
		};
	}
	return provenance;
}

function validateFile(value: unknown, index: number): ManifestFile {
	const where = `files[${index}]`;
	if (!isPlainObject(value)) {
		throw new ExportError("invalid_request", `${where} must be an object`);
	}
	const filePath = requireString(value, "path", where);
	if (!isNormalizedPosixRelativePath(filePath)) {
		throw new ExportError(
			"invalid_request",
			`${where}: path must be a normalized POSIX-relative path`,
			filePath,
		);
	}
	const size = value.size;
	if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
		throw new ExportError(
			"invalid_request",
			`${where}: size must be a non-negative integer`,
			filePath,
		);
	}
	const sha256 = value.sha256;
	if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) {
		throw new ExportError(
			"invalid_request",
			`${where}: sha256 must be 64 lowercase hex chars`,
			filePath,
		);
	}
	const kind = value.kind;
	if (typeof kind !== "string" || !FILE_KINDS.includes(kind as ManifestFileKind)) {
		throw new ExportError(
			"invalid_request",
			`${where}: kind must be one of ${FILE_KINDS.join("|")}`,
			filePath,
		);
	}
	const file: ManifestFile = {
		path: filePath,
		size,
		sha256,
		kind: kind as ManifestFileKind,
		sessionId: requireString(value, "sessionId", where),
	};
	const parentPath = optionalString(value, "parentPath", where);
	if (parentPath !== undefined) {
		if (!isNormalizedPosixRelativePath(parentPath)) {
			throw new ExportError(
				"invalid_request",
				`${where}: parentPath must be a normalized POSIX-relative path`,
				filePath,
			);
		}
		file.parentPath = parentPath;
	}
	return file;
}

/**
 * Validate an unknown decoded manifest against the frozen v1 shape and return
 * it typed. Throws {@link ExportError} with code `invalid_request` on any
 * violation (missing fields, non-normalized/absolute/`..` paths, duplicate
 * paths, unknown kinds, malformed hashes).
 */
export function validateManifest(manifest: unknown): ArchiveManifest {
	if (!isPlainObject(manifest)) {
		throw new ExportError("invalid_request", "manifest must be an object");
	}
	const validated: ArchiveManifest = {
		provenance: validateProvenance(manifest.provenance),
		files: [],
	};
	const files = manifest.files;
	if (!Array.isArray(files)) {
		throw new ExportError("invalid_request", "files must be an array");
	}
	const seen = new Set<string>();
	for (let index = 0; index < files.length; index++) {
		const file = validateFile(files[index], index);
		if (seen.has(file.path)) {
			throw new ExportError("invalid_request", `duplicate manifest path: ${file.path}`, file.path);
		}
		seen.add(file.path);
		validated.files.push(file);
	}
	return validated;
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
