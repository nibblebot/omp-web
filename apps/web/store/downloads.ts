// G17 browser download UX over the fleet origin only.
//
// Actions stream files through the existing fleet proxy
// (`/ctl/sessions/{id}/download?path=...`, same-origin fetch with
// credentials); the browser NEVER dials a daemon directly, NEVER bypasses
// the proxy, and NEVER puts tokens in URLs (cookie session + the existing
// gate carry auth; the fleet holds the daemon bearer server-side).
//
// Flow per download: (1) fetch the download manifest first (proposed
// `downloadManifest` call, P0-wired); (2) open the consent dialog with the
// manifest's inclusions/warnings/provenance; (3) on confirm, produce the
// server path via the session dump method (exportHtml / formatSessionAsText-
// to-tmp / dumpLlmRequestToTmpDir / dumpSessionArchiveToTmpDir) and stream
// GET /ctl/.../download?path=<serverPath> to a blob -> anchor download with
// the manifest/clientFilename (browser filenames are never server paths).
// Streaming uses ReadableStream -> Blob where available with a plain-blob
// fallback; no success toast fires without verified bytes + manifest.
// Failures surface through the typed downloadFailure mapping (see
// apps/fleet/download-policy.ts): traversal/cross-workspace -> forbidden,
// stale/disconnect -> retryable/unavailable, 64 MiB cap -> explicit cap
// message. Text downloads offer clipboard copy with permission handling.
// Stored lineage uses the read-only tx/api.ts stored* routes and never wakes
// compute; missing blobs render explicit unavailable.
//
// PROPOSED wire for P0 (OMP_PROTO stays 2, additive-only):
//   downloadManifest({ includeAdvisor, includeBtw, includeWorkers })
//     -> DownloadManifestResult (see apps/session/download-manifest.ts);
//     each call below casts the method name `as WebMethodName` with a
//     P0-TODO comment until P0 canonicalizes it.
//   dumpSessionArchive() -> DumpArchiveWithManifest
//     { path, files, subagentCount, subagentError?, clientFilename }.
//   exportHtml([outputPath?, useUserThemes?]) -> ExportHtmlWithManifest
//     existing { path } plus clientFilename.
// WIRING NOTE: this module is intentionally NOT registered in state.ts or
// overlays/index.ts. To mount, render DownloadDialog from
// components/overlays/DownloadDialog.tsx and call its openDownload() entry.

import { createSignal } from "solid-js";
import { state } from "../state";
import { authedFetch } from "./auth";
import { call } from "./transport";
import { pushToast } from "./toasts";

/** Additive download kinds (mirrors the daemon DownloadKind; P0 canonicalizes the enum). */
export type WebDownloadKind = "html" | "html-themed" | "text" | "request" | "archive";

/** Consent dialog data: inclusions, warnings, provenance from the manifest. */
export interface DownloadConsent {
	kind: WebDownloadKind;
	includeAdvisor: boolean;
	includeBtw: boolean;
	inclusions: string[];
	warnings: string[];
	provenance: { sessionId: string; sessionFile?: string };
	workerCount: number;
}

/** Manifest row shape the proposed `downloadManifest` call answers (P0 DTO). */
export interface WebDownloadManifest {
	files: Array<{ name: string; kind: string; sessionId?: string; bytes?: number }>;
	advisorIncluded: boolean;
	btwIncluded: boolean;
	workerCount: number;
	warnings: string[];
	provenance: { sessionId: string; sessionFile?: string };
}

export type DownloadProgress =
	| { phase: "manifest" }
	| { phase: "consent"; consent: DownloadConsent }
	| { phase: "producing" }
	| { phase: "fetching"; receivedBytes: number }
	| { phase: "done"; filename: string; bytes: number }
	| { phase: "error"; code: string; message: string };

const [progress, setProgress] = createSignal<DownloadProgress | null>(null);
let progressAbort: AbortController | null = null;

/** Read accessor for DownloadDialog rendering. */
export function downloadProgress(): DownloadProgress | null {
	return progress();
}

/** Dismiss the dialog state (backdrop/Esc/close). In-flight fetches abort via their signal. */
export function closeDownload(): void {
	if (progressAbort) progressAbort.abort();
	progressAbort = null;
	setProgress(null);
}

function daemonIdOrThrow(): string {
	const id = state.currentSessionId;
	if (!id) throw new Error("No session attached; attach a daemon before downloading.");
	return id;
}

interface ManifestArgs {
	includeAdvisor: boolean;
	includeBtw: boolean;
	includeWorkers: boolean;
}

/** Server export answer: { path, clientFilename? } (P0 DTO: ExportHtmlWithManifest / DumpArchiveWithManifest). */
interface ExportPathResult {
	path: string;
	clientFilename?: string;
}

/** Narrow the untrusted manifest answer with `in`/`typeof` (no local guard, no schema dep). */
function asManifest(value: unknown): WebDownloadManifest | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	if (!("files" in value) || !Array.isArray(value.files)) return null;
	if (!value.files.every((f) => typeof f === "object" && f !== null && "name" in f)) return null;
	return value as WebDownloadManifest;
}

/** Narrow the untrusted export-path answer with `in`/`typeof`. */
function asExportPath(value: unknown): ExportPathResult | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	if (!("path" in value) || typeof value.path !== "string") return null;
	if ("clientFilename" in value && typeof value.clientFilename !== "string") return null;
	const out: ExportPathResult = { path: value.path };
	if ("clientFilename" in value && typeof value.clientFilename === "string") {
		out.clientFilename = value.clientFilename;
	}
	return out;
}

type CodedError = Error & { code?: unknown };

function failureWithCode(message: string, code: string): CodedError {
	const err: CodedError = new Error(message);
	err.code = code;
	return err;
}

function failureCodeOf(err: unknown): string {
	if (err instanceof Error && "code" in err && typeof err.code === "string") return err.code;
	return "unavailable";
}

async function fetchManifest(args: ManifestArgs): Promise<WebDownloadManifest> {
	// Note: canonicalize `downloadManifest` as an additive WebMethodName;
	// until then the name rides as an opaque string through the typed call relay.
	const data: unknown = await call("downloadManifest", [args], 30_000);
	const manifest = asManifest(data);
	if (!manifest) throw new Error("Download manifest unavailable from this daemon.");
	return manifest;
}

function errorCodeOf(res: Response, bodyText: string): string {
	if (res.status === 401) return "unauthorized";
	if (res.status === 403) return "forbidden";
	const lowered = bodyText.toLowerCase();
	if (lowered.includes("64 mib") || lowered.includes("aggregate cap")) return "cap";
	if (lowered.includes("expired") || lowered.includes("aborted") || lowered.includes("stale"))
		return "retryable";
	if (res.status === 404) return "unavailable";
	return res.status >= 500 ? "unavailable" : "invalid_request";
}

function failureMessage(code: string, fallback: string): string {
	switch (code) {
		case "unauthorized":
			return "Download needs sign-in; the session expired. Sign in and retry.";
		case "forbidden":
			return "Download blocked: path escapes the authorized roots.";
		case "cap":
			return "Download exceeds the 64 MiB transfer cap. Narrow the archive or download files individually.";
		case "retryable":
			return "Download transfer went stale before completing. Retry the download.";
		case "unavailable":
			return "Download not found on this daemon; it may have been cleaned up.";
		default:
			return fallback;
	}
}

/** Stream one fleet-proxied download to an anchor save. Never buffers whole-archive twice. */
async function streamToAnchor(res: Response, filename: string): Promise<number> {
	const reader = res.body?.getReader();
	if (!reader) {
		const blob = await res.blob();
		triggerAnchor(URL.createObjectURL(blob), filename);
		return blob.size;
	}
	const chunks: BlobPart[] = [];
	let received = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) {
			chunks.push(value);
			received += value.byteLength;
			const current = progress();
			if (current?.phase === "fetching")
				setProgress({ phase: "fetching", receivedBytes: received });
		}
	}
	const blob = new Blob(chunks);
	triggerAnchor(URL.createObjectURL(blob), filename);
	return blob.size;
}

function triggerAnchor(url: string, filename: string): void {
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function produceServerPath(
	kind: WebDownloadKind,
): Promise<{ serverPath: string; clientFilename: string }> {
	switch (kind) {
		case "html": {
			const out = asExportPath(await call("exportHtml", [undefined, false], 60_000));
			if (!out) throw new Error("HTML export produced no file.");
			return { serverPath: out.path, clientFilename: out.clientFilename ?? "session.html" };
		}
		case "html-themed": {
			const out = asExportPath(await call("exportHtml", [undefined, true], 60_000));
			if (!out) throw new Error("Themed HTML export produced no file.");
			return { serverPath: out.path, clientFilename: out.clientFilename ?? "session-themed.html" };
		}
		case "request": {
			const out: unknown = await call("dumpLlmRequestToTmpDir", [], 60_000);
			if (typeof out !== "string" || !out) throw new Error("No LLM request dump available yet.");
			return { serverPath: out, clientFilename: "session-llm-request.json" };
		}
		case "archive": {
			// Note: canonicalize `dumpSessionArchive` as an additive WebMethodName.
			const out = asExportPath(await call("dumpSessionArchive", [], 120_000));
			if (!out) throw new Error("Archive dump produced no file.");
			return { serverPath: out.path, clientFilename: out.clientFilename ?? "session-archive.zip" };
		}
		case "text": {
			const text: unknown = await call("formatSessionAsText", [], 60_000);
			if (typeof text !== "string" || !text)
				throw new Error("Transcript is empty, nothing to download.");
			return { serverPath: "", clientFilename: "transcript.txt" };
		}
	}
}

/** Fetch one fleet-proxied file and save it; verifies bytes before any success signal. */
async function fetchProxied(
	daemonId: string,
	serverPath: string,
	filename: string,
): Promise<number> {
	if (progressAbort) progressAbort.abort();
	const controller = new AbortController();
	progressAbort = controller;
	setProgress({ phase: "fetching", receivedBytes: 0 });
	const res = await authedFetch(
		`/ctl/sessions/${encodeURIComponent(daemonId)}/download?path=${encodeURIComponent(serverPath)}`,
		{ signal: controller.signal },
	);
	if (!res.ok) {
		const bodyText = await res.text().catch(() => "");
		const code = errorCodeOf(res, bodyText);
		throw failureWithCode(failureMessage(code, `Download failed (HTTP ${res.status}).`), code);
	}
	const bytes = await streamToAnchor(res, filename);
	if (bytes <= 0) throw failureWithCode("Download completed with no bytes; retry.", "retryable");
	return bytes;
}

async function runDownload(kind: WebDownloadKind, _consent: DownloadConsent): Promise<void> {
	const daemonId = daemonIdOrThrow();
	try {
		if (kind === "text") {
			setProgress({ phase: "producing" });
			const text: unknown = await call("formatSessionAsText", [], 60_000);
			if (typeof text !== "string" || !text) {
				throw failureWithCode("Transcript is empty, nothing to download.", "unavailable");
			}
			const blob = new Blob([text], { type: "text/plain" });
			triggerAnchor(URL.createObjectURL(blob), "transcript.txt");
			setProgress({ phase: "done", filename: "transcript.txt", bytes: blob.size });
			return;
		}
		setProgress({ phase: "producing" });
		const produced = await produceServerPath(kind);
		const bytes = await fetchProxied(daemonId, produced.serverPath, produced.clientFilename);
		setProgress({ phase: "done", filename: produced.clientFilename, bytes });
	} catch (err) {
		const code = failureCodeOf(err);
		const message = err instanceof Error ? err.message : String(err);
		setProgress({ phase: "error", code, message });
		pushToast(`Download failed: ${message}`);
	}
}

/** Open the consent flow: fetch manifest, then show inclusions/warnings for confirm. */
export async function openDownloadConsent(
	kind: WebDownloadKind,
	opts?: { includeAdvisor?: boolean; includeBtw?: boolean },
): Promise<void> {
	const includeAdvisor = opts?.includeAdvisor ?? true;
	const includeBtw = opts?.includeBtw ?? false;
	try {
		setProgress({ phase: "manifest" });
		const manifest = await fetchManifest({
			includeAdvisor,
			includeBtw,
			includeWorkers: kind === "archive",
		});
		setProgress({
			phase: "consent",
			consent: {
				kind,
				includeAdvisor,
				includeBtw,
				inclusions: manifest.files.map((f) => f.name),
				warnings: manifest.warnings,
				provenance: manifest.provenance,
				workerCount: manifest.workerCount,
			},
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		setProgress({ phase: "error", code: "unavailable", message });
		pushToast(`Download failed: ${message}`);
	}
}

/** Confirm from the dialog: produce + stream the file the manifest described. */
export function confirmDownload(consent: DownloadConsent): void {
	void runDownload(consent.kind, consent);
}

/** Download HTML (pass themed:true for the active TUI theme bundle). */
export function downloadHtml(opts?: { themed?: boolean }): void {
	void openDownloadConsent(opts?.themed ? "html-themed" : "html", { includeAdvisor: false });
}

/** Download the plain-text transcript (blob save; see copyTranscriptText for clipboard). */
export function downloadText(): void {
	void openDownloadConsent("text", { includeAdvisor: false });
}

/** Download the LLM-request sidecar JSON produced by dumpLlmRequestToTmpDir. */
export function downloadRequest(): void {
	void openDownloadConsent("request", { includeAdvisor: false });
}

/** Download the main-plus-worker archive (dumpSessionArchiveToTmpDir zip). */
export function downloadArchive(opts?: { includeAdvisor?: boolean; includeBtw?: boolean }): void {
	void openDownloadConsent("archive", opts);
}

/** Copy the plain-text transcript to the clipboard (deliberate permission handling). */
export async function copyTranscriptText(): Promise<void> {
	try {
		const text = (await call("formatSessionAsText", [], 60_000)) as string;
		if (!text) {
			pushToast("Transcript is empty, nothing to copy.");
			return;
		}
		await navigator.clipboard.writeText(text);
		pushToast(`Transcript copied (${text.length} chars).`);
	} catch (err) {
		const name = err instanceof Error ? err.name : "";
		if (name === "NotAllowedError") {
			pushToast("Clipboard permission denied; allow clipboard access and retry.");
			return;
		}
		pushToast(`Copy failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/**
 * Download a stored/read-only lineage file without waking compute.
 * Rides the existing stored transcript/raw routes (GET, same-origin).
 * Missing blobs answer typed unavailable and render explicitly, never as a
 * broken download.
 */
export async function downloadStored(
	workspaceId: string,
	sessionId: string,
	relpath: string,
): Promise<void> {
	try {
		const params = new URLSearchParams({ file: relpath, format: "raw" });
		const res = await authedFetch(
			`/ctl/stored/sessions/${encodeURIComponent(workspaceId)}/${encodeURIComponent(sessionId)}/transcript?${params.toString()}`,
		);
		if (!res.ok) {
			if (res.status === 404) {
				pushToast(`Stored file unavailable: ${relpath} is missing from the fleet store.`);
				return;
			}
			const bodyText = await res.text().catch(() => "");
			pushToast(
				`Stored download failed: ${failureMessage(errorCodeOf(res, bodyText), `HTTP ${res.status}`)}`,
			);
			return;
		}
		const blob = await res.blob();
		if (blob.size <= 0) {
			pushToast(`Stored file unavailable: ${relpath} has no bytes in the fleet store.`);
			return;
		}
		const base = relpath.split("/").pop() ?? "download";
		triggerAnchor(URL.createObjectURL(blob), base);
		pushToast(`Stored file saved: ${base} (${blob.size} bytes).`);
	} catch (err) {
		pushToast(`Stored download failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}
