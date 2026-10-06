// G17 daemon-side download manifest + authorized-path resolution.
//
// Owns the server half of direct exports/downloads/main-plus-worker archives:
// inspecting the live session's actual artifacts (advisor recorders,
// BTW sidecars, worker transcripts) WITHOUT waking compute (pure filesystem
// reads + in-memory mirrors only), resolving a dump kind to an authorized
// server path, and serving the fleet's `download_bulk` callback command over
// the bulk channel.
//
// Reuses, never reinvents:
// - SDK dumps: `exportToHtml`, `formatSessionAsText`, `dumpLlmRequestToTmpDir`,
//   `dumpSessionArchiveToTmpDir` (run by the P0-wired session methods; this
//   module only authorizes + names their outputs).
// - Scoped lineage rules: `isAdvisorTranscriptName` (lib/session-files/
//   export-sessions.ts) for advisor detection; the `__advisor*.jsonl` vs
//   other-`*.jsonl`-is-subagent rule shared with the log tailer.
// - BTW layout: `<artifactsDir>/btw-history/sessions/<scope>` with the SDK's
//   scope-segment rule (`/^[\w-]+$/` inline, sha256 hex otherwise) mirrored
//   from `historyDirectory` (pi-coding-agent/src/session/btw-history.ts).
// - Callback wire: `DownloadBulkCommand` / `DownloadBulkFailedControl` and
//   the frozen 64 MiB `BULK_MAX_BYTES` (lib/wire/callback-protocol.ts).
// - Daemon `/download` jail semantics (apps/session/index.ts
//   `canonicalRoots`/`isInside`): realpath both sides, tmpdir + cwd +
//   process.cwd() + session-file dir; 403 on escape, 404 on missing.
//
// PROPOSED wire for P0 (OMP_PROTO stays 2, additive-only; P0 publishes to
// lib/wire/protocol.ts + apps/session/methods.ts, this module is the impl):
//   downloadManifest(args: DownloadManifestArgs) -> DownloadManifestResult
//     read-only row: buildDownloadManifest() below; never wakes compute.
//   dumpSessionArchive() -> DumpArchiveWithManifest
//     { path, files, subagentCount, subagentError?, clientFilename } row
//     wiring entry.session.dumpSessionArchiveToTmpDir() + resolveDownloadPath.
//   exportHtml([outputPath?, useUserThemes?]) -> ExportHtmlWithManifest
//     existing row's { path } extended with clientFilename from
//     resolveDownloadPath("html"|"html-themed", ...).
//   DownloadKind enum: "html" | "html-themed" | "text" | "request" | "archive".
//   Capability advertisement: Capability{available, reason} per daemon.

import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	readdirSync,
	realpathSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { openArchive, writeArchive } from "@oh-my-pi/pi-utils/ar";
import type { ArchiveMemberContent } from "@oh-my-pi/pi-utils/ar";
import { ExportError } from "#lib/session-files/archive-manifest";
import {
	isAdvisorTranscriptName,
	MAX_EXPORT_BYTES,
	MAX_EXPORT_FILES,
} from "#lib/session-files/export-sessions";
import { BULK_MAX_BYTES } from "#lib/wire/callback-protocol";
import type { CallbackErrorCode, DownloadBulkFailedControl } from "#lib/wire/callback-protocol";
import type { SessionEntry } from "./session-entry";

/** Additive download kinds (proposed DownloadKind enum for P0). */
export type DownloadKind = "html" | "html-themed" | "text" | "request" | "archive";

/** Proposed DownloadManifestArgs DTO for P0. */
export interface DownloadManifestArgs {
	includeAdvisor: boolean;
	includeBtw: boolean;
	includeWorkers: boolean;
	kind?: DownloadKind;
}

/** One manifest entry: a browser display name, never a server path used as identity. */
export interface DownloadManifestFile {
	/** Display name (basename or btw-history relative name). */
	name: string;
	kind: "main" | "subagent" | "advisor" | "btw" | "metadata";
	/** Owning lineage key (session-dir / main-file stem), not the SDK header UUID. */
	sessionId?: string;
	bytes?: number;
}

/** Proposed DownloadManifestResult DTO for P0. */
export interface DownloadManifestResult {
	files: DownloadManifestFile[];
	advisorIncluded: boolean;
	btwIncluded: boolean;
	workerCount: number;
	warnings: string[];
	provenance: { sessionId: string; sessionFile?: string };
}

/** Always-on consent copy: plaintext/credential disclosure warning. */
export const DOWNLOAD_PLAINTEXT_WARNING =
	"Session downloads contain full prompts, tool calls, and tool output and may include secrets " +
	"(API keys, tokens, file contents). Review before sharing or uploading anywhere.";

/** Redaction honesty: no SDK redaction API exists for these dumps, so never claim sealed. */
export const DOWNLOAD_NO_REDACTION_WARNING =
	"No redaction is applied: the SDK exposes no redaction API for these exports. " +
	"Omissions below are exclusions, not a sealed archive.";

/** Live inputs for the manifest builder (in-memory mirrors + fs roots; no compute wake). */
export interface DownloadManifestDeps {
	/** Stable lineage key (session-dir / main-file stem). Identity comes from here. */
	sessionId: string;
	/** Live main session file, when known (provenance only, never identity). */
	sessionFile?: string;
	/** Agent sessions root for the artifact-subtree scan. */
	sessionsDir: string;
	/** Task artifacts root for the btw-history scan; undefined = unknown (warn + omit). */
	artifactsDir?: string;
	/** Live worker transcript map (entry.transcriptSessionFilesBySubagentId). */
	subagentSessionFiles: ReadonlyMap<string, string>;
	/** Worker roster mirror (entry.subagentSnapshots sessionFile fallback). */
	subagentSnapshots: ReadonlyMap<string, { sessionFile?: string }>;
}

/** Scope-segment rule mirroring the SDK's btw-history `historyDirectory`. */
export function btwScopeSegment(scope: string): string {
	if (/^[\w-]+$/.test(scope)) return scope;
	return createHash("sha256").update(scope).digest("hex");
}

interface InspectedFile {
	path: string;
	file: DownloadManifestFile;
}

/** Reject symlinks and escapes rather than silently advertising unreadable artifacts. */
function inspectDownloadFiles(
	deps: DownloadManifestDeps,
	args: DownloadManifestArgs,
): InspectedFile[] {
	const files: InspectedFile[] = [];
	const seen = new Set<string>();
	let bytes = 0;
	const add = (path: string, root: string, file: DownloadManifestFile): void => {
		const st = lstatSync(path);
		if (st.isSymbolicLink() || !st.isFile())
			throw new ExportError("forbidden", "Download artifact is not a regular file.");
		const canonical = realpathSync(path);
		if (!insideRoots(canonical, [realpathSync(root)]))
			throw new ExportError("forbidden", "Download artifact escapes its session root.");
		if (seen.has(canonical)) return;
		seen.add(canonical);
		bytes += st.size;
		if (files.length >= MAX_EXPORT_FILES || bytes > MAX_EXPORT_BYTES)
			throw new ExportError(
				"unavailable",
				"Download artifact inspection exceeds its bounded traversal limit.",
			);
		files.push({ path: canonical, file: { ...file, bytes: st.size } });
	};
	if (deps.sessionFile)
		add(deps.sessionFile, dirname(deps.sessionFile), {
			name: basename(deps.sessionFile),
			kind: "main",
			sessionId: deps.sessionId,
		});
	const walk = (dir: string, root: string, prefix: string, depth: number): void => {
		if (depth > 64) throw new ExportError("unavailable", "Download lineage is too deeply nested.");
		for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			const path = join(dir, item.name);
			if (item.isSymbolicLink())
				throw new ExportError("forbidden", "Download lineage contains a symlink.");
			const name = prefix + item.name;
			if (item.isDirectory()) {
				if (args.includeWorkers) walk(path, root, `${name}/`, depth + 1);
				continue;
			}
			if (!item.name.endsWith(".jsonl") || item.name.includes(".bak")) continue;
			const advisor = isAdvisorTranscriptName(item.name);
			if (advisor ? !args.includeAdvisor : !args.includeWorkers) continue;
			add(path, root, { name, kind: advisor ? "advisor" : "subagent", sessionId: deps.sessionId });
		}
	};
	if (deps.sessionFile && (args.includeWorkers || args.includeAdvisor)) {
		const dir = deps.sessionFile.replace(/\.jsonl$/, "");
		try {
			const st = lstatSync(dir);
			if (st.isSymbolicLink() || !st.isDirectory())
				throw new ExportError("forbidden", "Invalid session artifact directory.");
			walk(dir, dirname(deps.sessionFile), "", 0);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
	}
	if (args.includeBtw && deps.artifactsDir) {
		const root = realpathSync(deps.artifactsDir);
		const dir = join(root, "btw-history", "sessions", btwScopeSegment(deps.sessionId));
		try {
			if (!insideRoots(realpathSync(dir), [root]) || lstatSync(dir).isSymbolicLink())
				throw new ExportError("forbidden", "BTW history escapes its authorized root.");
			for (const item of readdirSync(dir, { withFileTypes: true })) {
				if (!item.name.endsWith(".json")) continue;
				add(join(dir, item.name), root, {
					name: `btw-history/${item.name}`,
					kind: "btw",
					sessionId: deps.sessionId,
				});
			}
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
	}
	return files;
}

export function buildDownloadManifest(
	deps: DownloadManifestDeps,
	args: DownloadManifestArgs,
): DownloadManifestResult {
	const inspected = inspectDownloadFiles(deps, args);
	const files = inspected.map(({ file }) => file);
	const warnings = [DOWNLOAD_PLAINTEXT_WARNING, DOWNLOAD_NO_REDACTION_WARNING];
	if (args.includeBtw && !deps.artifactsDir)
		warnings.push("BTW history location is unavailable; no BTW history can be included.");
	return {
		files,
		advisorIncluded: files.some((file) => file.kind === "advisor"),
		btwIncluded: files.some((file) => file.kind === "btw"),
		workerCount: files.filter((file) => file.kind === "subagent").length,
		warnings,
		provenance: {
			sessionId: deps.sessionId,
			...(deps.sessionFile ? { sessionFile: deps.sessionFile } : {}),
		},
	};
}

/** Client filename shape per download kind. */
interface KindFilename {
	suffix: string;
	ext: string;
}

const KIND_FILENAME: Record<DownloadKind, KindFilename> = {
	html: { suffix: "", ext: ".html" },
	"html-themed": { suffix: "-themed", ext: ".html" },
	text: { suffix: "", ext: ".txt" },
	request: { suffix: "-llm-request", ext: ".json" },
	archive: { suffix: "-archive", ext: ".zip" },
};

function insideRoots(canonical: string, roots: readonly string[]): boolean {
	return roots.some((root) => {
		const rel = relative(realpathSync(root), canonical);
		return rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
	});
}

/**
 * Authorize a daemon-produced dump path and derive its browser filename.
 * Browser filenames are NEVER server paths: the clientFilename is built from
 * the stable session id + kind, never from the server path. The serverPath
 * must realpath-resolve inside one of the caller's canonical roots
 * (tmpdir/cwd/session-dir; the daemon passes its canonicalRoots()).
 * Throws ExportError with a ledger code: invalid_request (empty),
 * unavailable (not found / not a file), forbidden (jail escape).
 */
export function resolveDownloadPath(
	kind: DownloadKind,
	opts: { sessionId: string; serverPath: string; roots: readonly string[] },
): { serverPath: string; clientFilename: string } {
	if (!opts.serverPath) {
		throw new ExportError("invalid_request", `download ${kind}: no server path produced`);
	}
	let canonical: string;
	try {
		canonical = realpathSync(opts.serverPath);
	} catch {
		throw new ExportError("unavailable", `download ${kind}: file not found on this daemon`);
	}
	let regular = false;
	try {
		regular = statSync(canonical).isFile();
	} catch {
		throw new ExportError("unavailable", `download ${kind}: file not found on this daemon`);
	}
	if (!regular) {
		throw new ExportError("unavailable", `download ${kind}: not a file on this daemon`);
	}
	if (opts.roots.length === 0 || !insideRoots(canonical, opts.roots)) {
		throw new ExportError("forbidden", `download ${kind}: path escapes the authorized roots`);
	}
	const shape = KIND_FILENAME[kind];
	const idSegment = opts.sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
	const safeId = idSegment === "" ? "session" : idSegment;
	return { serverPath: canonical, clientFilename: `session-${safeId}${shape.suffix}${shape.ext}` };
}

/** Narrow an error's code to the frozen callback vocabulary (acks carry typed codes). */
function downloadErrorCode(err: unknown): CallbackErrorCode {
	if (typeof err !== "object" || err === null) return "retryable";
	if (!("code" in err)) return "retryable";
	const code = err.code;
	if (typeof code !== "string") return "retryable";
	switch (code) {
		case "invalid_request":
		case "invalid_identity":
		case "unauthorized":
		case "forbidden":
		case "unavailable":
		case "conflict":
		case "generation_obsolete":
		case "writer_active":
		case "archive_pending":
		case "archive_conflict":
		case "provider_failed":
		case "retryable":
			return code;
		default:
			return "retryable";
	}
}

/** DownloadBulkCommand shape the fleet sends (kind "command" envelopes); narrow without casts. */
export interface DownloadBulkPayload {
	type: "download_bulk";
	correlationId: string;
	path: string;
	sessionId?: string;
}

/** Type guard for the index.ts/daemon-control patch: kind "command" envelopes carrying download_bulk. */
export function isDownloadBulkCommand(payload: unknown): payload is DownloadBulkPayload {
	if (typeof payload !== "object" || payload === null) return false;
	if (!("type" in payload) || !("correlationId" in payload) || !("path" in payload)) return false;
	const type = payload.type;
	const correlationId = payload.correlationId;
	const pathValue = payload.path;
	if (
		type !== "download_bulk" ||
		typeof correlationId !== "string" ||
		typeof pathValue !== "string"
	) {
		return false;
	}
	return true;
}

/** Bulk upload part size (matches the fleet-callback default; neither side buffers whole). */
export const DOWNLOAD_BULK_PART_BYTES = 4 * 1024 * 1024;

export interface DownloadBulkServeDeps {
	correlationId: string;
	/** Opaque server path from the fleet (validated against the jail here, at read time). */
	path: string;
	/** Daemon cwd for relative-path resolution (mirrors /download: cwd, then process.cwd()). */
	cwd: string;
	/** Canonical (realpath) authorized roots from the daemon's canonicalRoots(). */
	roots: readonly string[];
	uploadParts: (input: {
		correlationId: string;
		totalBytes: number;
		readPart: (part: number, partSize: number) => Promise<Uint8Array>;
	}) => Promise<void>;
	failControl: (payload: DownloadBulkFailedControl) => void;
}

/**
 * Serve one `download_bulk` callback command: jail-check the path at read
 * time (same rules as HTTP /download), enforce the 64 MiB aggregate cap
 * BEFORE streaming, then upload in 4 MiB parts. Every failure reports via
 * DownloadBulkFailedControl and fails the whole correlation; nothing throws
 * to the caller (the daemon-control dispatch must stay alive).
 */
export async function serveDownloadBulk(deps: DownloadBulkServeDeps): Promise<void> {
	const fail = (code: CallbackErrorCode, message: string): void => {
		deps.failControl({
			type: "download_bulk_failed",
			correlationId: deps.correlationId,
			error: { code, message },
		});
	};
	if (!deps.path) {
		fail("invalid_request", "download_bulk requires a path");
		return;
	}
	const candidate = isAbsolute(deps.path) ? deps.path : resolve(deps.cwd, deps.path);
	let canonical: string | null = null;
	try {
		canonical = realpathSync(candidate);
	} catch {
		canonical = null;
	}
	if (canonical === null && !isAbsolute(deps.path)) {
		try {
			canonical = realpathSync(resolve(process.cwd(), deps.path));
		} catch {
			canonical = null;
		}
	}
	if (canonical === null) {
		fail("unavailable", "download not found on this daemon");
		return;
	}
	const resolved = canonical;
	let size: number;
	try {
		const st = statSync(resolved);
		if (!st.isFile()) {
			fail("unavailable", "download not found on this daemon");
			return;
		}
		size = st.size;
	} catch {
		fail("unavailable", "download not found on this daemon");
		return;
	}
	if (deps.roots.length === 0 || !insideRoots(resolved, deps.roots)) {
		fail("forbidden", "download blocked: path escapes the authorized roots");
		return;
	}
	if (size > BULK_MAX_BYTES) {
		fail(
			"unavailable",
			`download of ${size} bytes exceeds the 64 MiB bulk cap; narrow the archive or download files individually`,
		);
		return;
	}
	let fd: number | null = null;
	try {
		fd = openSync(resolved, "r");
		const handle = fd;
		if (realpathSync(resolved) !== resolved || !insideRoots(resolved, deps.roots))
			throw new ExportError("forbidden", "Download path changed during authorization.");
		const opened = fstatSync(handle);
		const current = statSync(resolved);
		if (
			!opened.isFile() ||
			opened.dev !== current.dev ||
			opened.ino !== current.ino ||
			opened.size !== size
		)
			throw new ExportError("retryable", "Download artifact changed before transfer.");
		await deps.uploadParts({
			correlationId: deps.correlationId,
			totalBytes: size,
			readPart: async (part, partSize) => {
				const out = new Uint8Array(partSize);
				let done = 0;
				while (done < partSize) {
					const got = readSync(
						handle,
						out,
						done,
						partSize - done,
						part * DOWNLOAD_BULK_PART_BYTES + done,
					);
					if (got <= 0)
						throw new ExportError("retryable", "Download artifact was truncated during transfer.");
					done += got;
				}
				return out.subarray(0, done);
			},
		});
	} catch (err) {
		fail(downloadErrorCode(err), err instanceof Error ? err.message : String(err));
	} finally {
		if (fd !== null) {
			try {
				closeSync(fd);
			} catch {
				// Close failure after a completed upload is not a transfer failure.
			}
		}
	}
}

export interface DownloadMethodsDeps {
	manifestDeps: (entry: SessionEntry) => DownloadManifestDeps;
	roots: (entry: SessionEntry) => readonly string[];
}

function downloadArgs(value: unknown): DownloadManifestArgs {
	if (!value || typeof value !== "object")
		throw new ExportError("invalid_request", "Download options are required.");
	if (
		!("includeAdvisor" in value) ||
		typeof value.includeAdvisor !== "boolean" ||
		!("includeBtw" in value) ||
		typeof value.includeBtw !== "boolean" ||
		!("includeWorkers" in value) ||
		typeof value.includeWorkers !== "boolean"
	)
		throw new ExportError("invalid_request", "Download inclusion choices must be boolean.");
	const kind = "kind" in value ? value.kind : "archive";
	if (
		kind !== "html" &&
		kind !== "html-themed" &&
		kind !== "text" &&
		kind !== "request" &&
		kind !== "archive"
	)
		throw new ExportError("invalid_request", "Unknown download kind.");
	if (kind !== "archive" && (value.includeAdvisor || value.includeBtw))
		throw new ExportError(
			"invalid_request",
			"Advisor and BTW inclusion is supported only by archives.",
		);
	return {
		kind,
		includeAdvisor: value.includeAdvisor,
		includeBtw: value.includeBtw,
		includeWorkers: value.includeWorkers,
	};
}

/** SDK exports stay authoritative; optional plaintext artifacts are explicit ZIP members. */
export function createDownloadMethods(deps: DownloadMethodsDeps) {
	const downloadManifest = async (entry: SessionEntry, a: unknown[]) =>
		buildDownloadManifest(deps.manifestDeps(entry), downloadArgs(a[0]));
	const exportDownload = async (entry: SessionEntry, a: unknown[]) => {
		const args = downloadArgs(a[0]);
		const kind = args.kind!;
		const input = deps.manifestDeps(entry);
		const manifest = buildDownloadManifest(input, args);
		let path: string;
		if (kind === "html" || kind === "html-themed") {
			path = await entry.session.exportToHtml(undefined, kind === "html-themed");
		} else if (kind === "text") {
			const text = entry.session.formatSessionAsText();
			if (!text) throw new ExportError("unavailable", "The transcript is empty.");
			path = join(tmpdir(), `omp-text-${randomUUID()}.txt`);
			await Bun.write(path, text);
		} else if (kind === "request") {
			const dumped = await entry.session.dumpLlmRequestToTmpDir();
			if (!dumped) throw new ExportError("unavailable", "No request context is available.");
			path = dumped;
		} else {
			// Inspect first, before the SDK discovers any worker paths.
			const inspected = inspectDownloadFiles(input, args);
			const dumped = await entry.session.dumpSessionArchiveToTmpDir();
			if (!dumped) throw new ExportError("unavailable", "The session archive is empty.");
			if (dumped.subagentError) {
				unlinkSync(dumped.path);
				throw new ExportError(
					"unavailable",
					"Worker transcript discovery failed; archive coverage cannot be verified.",
				);
			}
			try {
				const archive = await openArchive(dumped.path);
				const members: Array<readonly [string, ArchiveMemberContent]> = [];
				const outputFiles: DownloadManifestFile[] = [];
				let total = 0;
				for (const name of dumped.files) {
					if (name.startsWith("subagents/") && !args.includeWorkers) continue;
					if (name.startsWith("/") || name.split("/").includes(".."))
						throw new ExportError("forbidden", "Unsafe archive member.");
					const bytes = (await archive.readFile(name)).bytes;
					total += bytes.byteLength;
					if (total > BULK_MAX_BYTES)
						throw new ExportError("unavailable", "Archive exceeds the 64 MiB aggregate cap.");
					members.push([name, bytes]);
					outputFiles.push({
						name,
						kind: name.startsWith("subagents/")
							? "subagent"
							: name === "session.md"
								? "main"
								: "metadata",
						bytes: bytes.byteLength,
						sessionId: input.sessionId,
					});
				}
				for (const item of inspected) {
					if (item.file.kind !== "advisor" && item.file.kind !== "btw") continue;
					// Recheck realpath/type/roots immediately before reading.
					const st = lstatSync(item.path);
					if (!st.isFile() || st.isSymbolicLink())
						throw new ExportError("forbidden", "Artifact changed before export.");
					resolveDownloadPath("archive", {
						sessionId: input.sessionId,
						serverPath: item.path,
						roots: deps.roots(entry),
					});
					total += st.size;
					if (total > BULK_MAX_BYTES)
						throw new ExportError("unavailable", "Archive exceeds the 64 MiB aggregate cap.");
					const name = item.file.kind === "advisor" ? `advisors/${item.file.name}` : item.file.name;
					members.push([name, Bun.file(item.path)]);
					outputFiles.push({ ...item.file, name, bytes: st.size });
				}
				manifest.files = outputFiles;
				manifest.workerCount = outputFiles.filter((file) => file.kind === "subagent").length;
				members.push(["download-manifest.json", JSON.stringify(manifest, null, 2)]);
				path = join(tmpdir(), `omp-download-${randomUUID()}.zip`);
				await writeArchive(path, "zip", members);
			} finally {
				unlinkSync(dumped.path);
			}
		}
		const resolved = resolveDownloadPath(kind, {
			sessionId: input.sessionId,
			serverPath: path,
			roots: deps.roots(entry),
		});
		return { path: resolved.serverPath, clientFilename: resolved.clientFilename, manifest };
	};
	return { downloadManifest, exportDownload, dumpSessionArchive: exportDownload };
}
