// G17 fleet-side download policy: pure typed-failure mapping, safe
// response headers, and the 64 MiB bulk-cap gate.
//
// Imported by apps/fleet/edge.ts `#handleDownload` (one-line patch intent,
// see the PATCH INTENT block at the bottom). No filesystem access, no
// transport of its own: the existing DOWNLOAD_ROUTE + #handleDownload proxy
// (direct/worktree /download with server-held bearer) and the capture bulk
// correlation (`download_bulk` on CALLBACK_CONTROL_STREAM_ID, 64 MiB
// BULK_MAX_BYTES aggregate cap) stay exactly as they are.
//
// Never touches lib/wire/protocol.ts, lib/wire/callback-protocol.ts, or
// lib/wire/sse.ts (frozen). Uses only the frozen CallbackErrorCode
// vocabulary for the public failure `code`.

import { BULK_MAX_BYTES } from "#lib/wire/callback-protocol";
import type { CallbackErrorCode } from "#lib/wire/callback-protocol";

/** Browser-facing typed download failure (message is user-safe: no tokens, no server paths). */
export interface DownloadFailure {
	code: "unauthorized" | "forbidden" | "unavailable" | "invalid_request" | "retryable";
	message: string;
}

/**
 * Map an upstream/transport outcome to a typed browser failure. Pure:
 * traversal and cross-workspace rejections are forbidden/invalid_request,
 * stale/expired correlations and transport hiccups are retryable, cap
 * breaches are unavailable with the explicit cap message.
 */
export function downloadFailureKind(status: number, body?: string): DownloadFailure {
	const text = (body ?? "").toLowerCase();
	switch (status) {
		case 401:
			return {
				code: "unauthorized",
				message: "Download needs sign-in; the session expired. Sign in and retry.",
			};
		case 403:
			return { code: "forbidden", message: "Download blocked: path escapes the authorized roots." };
		case 400:
			return {
				code: "invalid_request",
				message: "Download request was malformed; check the selection and retry.",
			};
		case 404:
			return {
				code: "unavailable",
				message: "Download not found on this daemon; it may have been cleaned up.",
			};
		case 502:
		case 503:
		case 504:
			if (text.includes("no live callback pair") || text.includes("no callback transport")) {
				return {
					code: "unavailable",
					message:
						"Download unavailable: the workspace daemon has no live connection. Wake it and retry.",
				};
			}
			if (
				text.includes("unknown bulk correlation") ||
				(text.includes("correlation") && text.includes("expired")) ||
				text.includes("transfer aborted") ||
				text.includes("no live callback")
			) {
				return {
					code: "retryable",
					message: "Download transfer went stale before completing. Retry the download.",
				};
			}
			if (text.includes("64 mib") || text.includes("aggregate cap") || text.includes("exceeds")) {
				return overBulkCapMessage();
			}
			return {
				code: "unavailable",
				message: "Download failed on the daemon side. Retry; if it persists, narrow the selection.",
			};
		default:
			if (text.includes("64 mib") || text.includes("aggregate cap")) return overBulkCapMessage();
			if (
				text.includes("unknown bulk correlation") ||
				text.includes("expired") ||
				text.includes("aborted") ||
				text.includes("econnreset") ||
				text.includes("timeout")
			) {
				return {
					code: "retryable",
					message: "Download transfer went stale before completing. Retry the download.",
				};
			}
			return {
				code: status >= 500 ? "unavailable" : "invalid_request",
				message: `Download failed (HTTP ${status}). Retry; if it persists, narrow the selection.`,
			};
	}
}

/** Explicit cap failure: names the 64 MiB ceiling and the narrowing remedy. */
export function overBulkCapMessage(): DownloadFailure {
	return {
		code: "unavailable",
		message:
			`Download exceeds the 64 MiB transfer cap (${BULK_MAX_BYTES} bytes). ` +
			"Narrow the archive (fewer workers/advisor/BTW) or download files individually.",
	};
}

/**
 * Throw an Export-capped error when `bytes` exceeds the 64 MiB aggregate cap.
 * The edge calls this on the clone capture result BEFORE serving bytes; the
 * daemon/callback transport already caps parts, this names the outcome.
 */
export function enforceBulkCap(bytes: number): void {
	if (bytes > BULK_MAX_BYTES) throw new BulkCapError(overBulkCapMessage().message);
}

/** Error thrown by enforceBulkCap: already carries the user-safe cap message. */
export class BulkCapError extends Error {
	readonly code: CallbackErrorCode = "unavailable";
	constructor(message: string) {
		super(message);
		this.name = "BulkCapError";
	}
}

const SAFE_CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".zip": "application/zip",
	".md": "text/markdown; charset=utf-8",
};

/**
 * Safe download response headers: Content-Disposition attachment with a
 * sanitized basename (directory parts, quotes, CR/LF stripped; never a
 * server path), a conservative Content-Type allowlisted by extension
 * (unknown -> application/octet-stream), and no server-path echo.
 */
export function safeDownloadHeaders(
	clientFilename: string,
	contentType?: string,
): { "content-type": string; "content-disposition": string } {
	const base = clientFilename.split("/").pop()?.split("\\").pop() ?? "download";
	const sanitized =
		base
			.replace(/["\r\n]/g, "_")
			.replace(/[\x00-\x1f\x7f]/g, "_")
			.slice(0, 128) || "download";
	const dot = sanitized.lastIndexOf(".");
	const ext = dot >= 0 ? sanitized.slice(dot).toLowerCase() : "";
	const resolvedType =
		contentType !== undefined && /^[a-z]+\/[a-z0-9.+-]+(;\s*charset=[^;]+)?$/i.test(contentType)
			? contentType
			: (SAFE_CONTENT_TYPES[ext] ?? "application/octet-stream");
	return {
		"content-type": resolvedType,
		"content-disposition": `attachment; filename="${sanitized}"`,
	};
}

// ---------------------------------------------------------------------------
// PATCH INTENT for apps/fleet/edge.ts #handleDownload (main agent applies;
// shared file, keep the edit surgical and additive-only):
//
// 1. At the top import block (next to the callback-protocol import):
//      import { downloadFailureKind, enforceBulkCap, overBulkCapMessage, safeDownloadHeaders } from "./download-policy";
// 2. In the clone branch: replace the ad-hoc `content-disposition` header
//    object with `safeDownloadHeaders(name)`; call `enforceBulkCap(
//    result.data.byteLength)` before constructing the Response; map the
//    failure branch through `downloadFailureKind(502, result.error)` so the
//    JSON body carries `{ error: { code, message } }` instead of a bare string.
// 3. In the direct/worktree branch: map `!upstream.ok` through
//    `downloadFailureKind(upstream.status)` with the same typed body, and
//    build the success headers via `safeDownloadHeaders(name,
//    upstream.headers.get("content-type") ?? undefined)` so the daemon's
//    disposition never leaks a server path. Fall back to
//    `overBulkCapMessage()` when the clone failure text names the cap.
// No route, auth, or transport change: DOWNLOAD_ROUTE,_browser auth gate,
// bearer forwarding, and the capture correlation stay untouched.
// ---------------------------------------------------------------------------
