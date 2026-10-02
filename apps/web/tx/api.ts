/**
 * Typed client for the fleet stats API (historical transcripts/stats view).
 * Wire types are single-sourced from lib/wire/stats-types.ts; do not mirror.
 * All requests use relative /ctl/stats paths: vite proxies /ctl to the fleet
 * control plane (loopback :4722) in dev; same-origin in prod.
 */

import type {
	Health,
	LongestCall,
	RawEntry,
	SessionsResponse,
	SessionStats,
	SessionSummary,
	StoredFileInfo,
	StoredSessionDetail,
	StoredSessionSummary,
	StoredSessionsResponse,
	StoredWorkspaceProvenance,
	StoredWorkspaceSummary,
	StoredWorkspacesResponse,
	SubagentInfo,
	SyncResult,
	ToolStat,
	TranscriptPage,
} from "#lib/wire/stats-types";
import { encodePathSegments } from "./util/format";
import { authedFetch } from "../store/auth";

export type {
	Health,
	LongestCall,
	RawEntry,
	SessionsResponse,
	SessionStats,
	SessionSummary,
	StoredFileInfo,
	StoredSessionDetail,
	StoredSessionSummary,
	StoredSessionsResponse,
	StoredWorkspaceProvenance,
	StoredWorkspaceSummary,
	StoredWorkspacesResponse,
	SubagentInfo,
	SyncResult,
	ToolStat,
	TranscriptPage,
} from "#lib/wire/stats-types";

/** Fetch failure carrying the HTTP status; message prefers the server's `{error}`. */
export class ApiError extends Error {
	readonly status: number;
	/** Server typed-error code (e.g. "unavailable" / "invalid_request") when the body named one. */
	readonly code: string | null;
	constructor(message: string, status: number, code: string | null = null) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
	}
}

/**
 * Read the server's error body ({ error: string } or the fleet typed shape
 * { error: { code, message } }) into a message; HTTP status is the fallback.
 * Returns null when the body carries nothing readable.
 */
function errorMessageFromBody(body: unknown): { message: string; code?: string } | null {
	if (typeof body !== "object" || body === null || !("error" in body)) return null;
	const err: unknown = body.error;
	if (typeof err === "string") return { message: err };
	if (typeof err === "object" && err !== null) {
		const code: unknown = "code" in err ? err.code : undefined;
		const message: unknown = "message" in err ? err.message : undefined;
		if (typeof code === "string" && typeof message === "string") return { message, code };
		if (typeof message === "string") return { message };
	}
	return null;
}

export const REQUEST_TIMEOUT_MS = 30_000;

/** Append search params to a relative path, with no origin resolution
 *  (the caller's origin serves /ctl). */
function withParams(path: string, params?: Record<string, string | number | undefined>): string {
	if (!params) return path;
	const qs = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
	}
	const s = qs.toString();
	return s === "" ? path : `${path}?${s}`;
}

async function fetchJson<T>(
	path: string,
	params?: Record<string, string | number | undefined>,
	init?: RequestInit,
): Promise<T> {
	const url = withParams(path, params);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const res = await fetch(url, { ...init, signal: controller.signal });
		if (!res.ok) {
			let message = `HTTP ${res.status}`;
			let code: string | null = null;
			try {
				const body: unknown = await res.json();
				const parsed = errorMessageFromBody(body);
				if (parsed !== null) {
					message = parsed.message;
					code = parsed.code ?? null;
				}
			} catch {
				// non-JSON error body, so keep the status line
			}
			throw new ApiError(message, res.status, code);
		}
		try {
			return (await res.json()) as T;
		} catch {
			// 2xx with a non-JSON body; surface it as an error.
			throw new ApiError(`Invalid JSON response from ${path}`, res.status);
		}
	} catch (e) {
		if (e instanceof ApiError) throw e;
		if (e instanceof Error && e.name === "AbortError") {
			throw new ApiError("Request timed out", 0);
		}
		throw e;
	} finally {
		clearTimeout(timer);
	}
}

export const api = {
	health: () => fetchJson<Health>("/ctl/stats/health"),

	sessions: (q?: string) => fetchJson<SessionsResponse>("/ctl/stats/sessions", { q }),

	stats: (file: string) =>
		fetchJson<SessionStats>(`/ctl/stats/sessions/${encodePathSegments(file)}/stats`),

	transcript: (file: string, offset: number | null, limit: number) =>
		fetchJson<TranscriptPage>(`/ctl/stats/sessions/${encodePathSegments(file)}/transcript`, {
			offset: offset ?? undefined,
			limit,
		}),

	/** Server envelope is { subagents: SubagentInfo[] }; accept a bare array defensively too. */
	subagents: async (file: string): Promise<SubagentInfo[]> => {
		const data = (await fetchJson<unknown>(
			`/ctl/stats/sessions/${encodePathSegments(file)}/subagents`,
		)) as SubagentInfo[] | { subagents?: SubagentInfo[] };
		return Array.isArray(data) ? data : (data.subagents ?? []);
	},

	/** Shell out to `omp stats --summary` on the server and re-probe its stats.db handle. */
	sync: (): Promise<SyncResult> =>
		fetchJson<SyncResult>("/ctl/stats/sync", undefined, { method: "POST" }),

	// -----------------------------------------------------------------------
	// Fleet log-store read surface (P8.5). Read-only GETs ride the same
	// cookie session as the /ctl/stats routes (plain same-origin fetch);
	// ids are single path segments, encoded individually. Never wakes
	// compute; nothing here offers a resume/download affordance.
	// -----------------------------------------------------------------------

	storedWorkspaces: (): Promise<StoredWorkspacesResponse> =>
		fetchJson<StoredWorkspacesResponse>("/ctl/stored/workspaces"),

	storedSessions: (workspaceId?: string): Promise<StoredSessionsResponse> =>
		fetchJson<StoredSessionsResponse>(
			workspaceId !== undefined && workspaceId !== ""
				? `/ctl/stored/sessions?workspaceId=${encodePathSegments(workspaceId)}`
				: "/ctl/stored/sessions",
		),

	storedSessionDetail: (workspaceId: string, sessionId: string): Promise<StoredSessionDetail> =>
		fetchJson<StoredSessionDetail>(
			`/ctl/stored/sessions/${encodePathSegments(workspaceId)}/${encodePathSegments(sessionId)}`,
		),

	storedTranscript: (
		workspaceId: string,
		sessionId: string,
		options?: { file?: string; offset?: number; limit?: number },
	): Promise<TranscriptPage> =>
		fetchJson<TranscriptPage>(
			`/ctl/stored/sessions/${encodePathSegments(workspaceId)}/${encodePathSegments(
				sessionId,
			)}/transcript`,
			{ file: options?.file, offset: options?.offset, limit: options?.limit },
		),

	/**
	 * Raw stored bytes (application/x-ndjson, byte-identical to the stream).
	 * `file` defaults to the main relpath on the server when omitted; a
	 * missing (derived) file answers 404 { error: { code: "unavailable" } };
	 * the caller renders it as unavailable, never as a download.
	 */
	storedRaw: async (workspaceId: string, sessionId: string, file: string): Promise<string> => {
		const params = new URLSearchParams({ file, format: "raw" });
		const res = await fetch(
			`/ctl/stored/sessions/${encodePathSegments(workspaceId)}/${encodePathSegments(
				sessionId,
			)}/transcript?${params.toString()}`,
			{ credentials: "same-origin" },
		);
		if (!res.ok) {
			let message = `HTTP ${res.status}`;
			let code: string | null = null;
			try {
				const body: unknown = await res.json();
				const parsed = errorMessageFromBody(body);
				if (parsed !== null) {
					message = parsed.message;
					code = parsed.code ?? null;
				}
			} catch {
				// non-JSON error body: keep the status line
			}
			throw new ApiError(message, res.status, code);
		}
		return res.text();
	},

	/**
	 * Resume-onto-fresh-clone (orphaned/deleted workspaces ONLY, the ONLY
	 * resume affordance; fleet-stored browsing never offers inline Resume).
	 * A mutation: authedFetch adds the session CSRF header and handles 401.
	 * `resumePath` is the workspace summary's resumeClonePath, server-issued.
	 */
	resumeClone: async (
		resumePath: string,
		sessionId: string,
		profileId?: string,
	): Promise<Record<string, unknown>> => {
		const res = await authedFetch(resumePath, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(profileId !== undefined ? { sessionId, profileId } : { sessionId }),
		});
		if (!res.ok) {
			let message = `HTTP ${res.status}`;
			let code: string | null = null;
			try {
				const body: unknown = await res.json();
				const parsed = errorMessageFromBody(body);
				if (parsed !== null) {
					message = parsed.message;
					code = parsed.code ?? null;
				}
			} catch {
				// non-JSON error body: keep the status line
			}
			throw new ApiError(message, res.status, code);
		}
		try {
			const body: unknown = await res.json();
			if (typeof body === "object" && body !== null && !Array.isArray(body)) {
				return body as Record<string, unknown>;
			}
			return {};
		} catch {
			// 2xx with no JSON body (e.g. 204): nothing to parse.
			return {};
		}
	},
};
