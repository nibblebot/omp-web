/**
 * Browser auth domain (P2.4 store facade): opaque 256-bit session cookie
 * (`omp_session`, HttpOnly + Secure + SameSite=Lax, 30-day absolute expiry;
 * ledger "Browser auth" in docs/clone-contracts.md). The access token lives
 * ONLY for the duration of a signIn() call: it is posted once to
 * POST /auth/login and dropped. The client persists NOTHING: no
 * localStorage/sessionStorage, no tokens in the URL; the browser keeps only
 * the server-issued HttpOnly cookie, and this module caches the per-session
 * CSRF token in memory for mutation headers. Every request is same-origin so
 * the cookie rides along automatically.
 *
 * This module deliberately does NOT import state.ts (its fields live in
 * state.ts, which owns the modal registry): module-private state + listeners,
 * like transport.ts's `connected` flag. Main wires it by mirroring snapshots
 * into state fields and opening the sign-in modal on `signedOut`:
 *
 * 	subscribeAuth((snap) => {
 * 		setState("authStatus", snap.status);
 * 		setState("authExpiresAt", snap.expiresAt);
 * 		if (snap.status === "signedOut") setState("modal", "sign-in");
 * 	});
 */

/** Session lifecycle as the client sees it. `unknown` = not yet probed. */
export type AuthStatus = "unknown" | "signedOut" | "signedIn";

/** Auth state exposed to the UI. `expiresAt` is epoch ms of the server
 *  session's absolute (non-sliding) expiry, when the server reported it. */
export interface AuthSnapshot {
	status: AuthStatus;
	expiresAt?: number;
}

/** Typed auth failure per the ledger error vocabulary. `status` is the HTTP
 *  status (0 = fetch-level network failure); `code` is a ledger typed error
 *  (server-supplied when the body names one, otherwise the status fallback). */
export class AuthError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, code: string, message: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

// ---------------------------------------------------------------------------
// Module-private auth state (Main mirrors it into state.ts via subscribeAuth)
// ---------------------------------------------------------------------------

let status: AuthStatus = "unknown";
let expiresAt: number | undefined;
/** Per-session CSRF token from the login/session answers. Memory-only by
 *  contract, never persisted, never placed in the URL. */
let csrf: string | null = null;

const listeners = new Set<(snapshot: AuthSnapshot) => void>();

function snapshot(): AuthSnapshot {
	return expiresAt === undefined ? { status } : { status, expiresAt };
}

/** Move the auth state and notify listeners. Silent no-op when nothing
 *  changes; concurrent 401s collapse into one signedOut notification. */
function transition(next: AuthStatus, nextExpiresAt?: number): AuthSnapshot {
	if (status === next && expiresAt === nextExpiresAt) return snapshot();
	status = next;
	expiresAt = nextExpiresAt;
	const snap = snapshot();
	for (const listener of listeners) listener(snap);
	return snap;
}

/** Current auth state (a fresh snapshot object; UI reads, never mutates). */
export function authSnapshot(): AuthSnapshot {
	return snapshot();
}

/** Cached CSRF token for mutation headers, or null before the first
 *  login/session answer. Prefer authedFetch() over hand-assembling headers. */
export function csrfToken(): string | null {
	return csrf;
}

/** Register an auth-state listener; the returned function unsubscribes.
 *  `signedOut` notifications are the open-the-sign-in-modal signal. */
export function subscribeAuth(listener: (snapshot: AuthSnapshot) => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

const CSRF_HEADER = "X-Omp-Csrf";

/** Ledger typed-error fallback by HTTP status when the body names no code. */
function fallbackCode(status: number): string {
	if (status === 400) return "invalid_request";
	if (status === 401) return "unauthorized";
	if (status === 403) return "forbidden";
	return "unavailable";
}

/** Parse an error response into an AuthError: accepts `{ error: "msg" }`,
 *  `{ error: { code, message } }` (the fleet's typed-error shape) or any
 *  non-JSON body (status-based fallbacks). */
async function readAuthError(res: Response, action: string): Promise<AuthError> {
	let message = `${action} failed (HTTP ${res.status})`;
	let code = fallbackCode(res.status);
	try {
		const body: unknown = await res.json();
		if (typeof body === "object" && body !== null && "error" in body) {
			const err: unknown = body.error;
			if (typeof err === "string") {
				message = err;
			} else if (typeof err === "object" && err !== null) {
				const codeField: unknown = "code" in err ? err.code : undefined;
				const messageField: unknown = "message" in err ? err.message : undefined;
				if (typeof messageField === "string") message = messageField;
				if (typeof codeField === "string") code = codeField;
			}
		}
	} catch {
		// Body was not JSON; keep the status-based fallbacks.
	}
	return new AuthError(res.status, code, message);
}

/** Tolerant JSON read: a 2xx without a JSON body degrades to `{}`. */
async function readJsonObject(res: Response): Promise<Record<string, unknown>> {
	try {
		const body: unknown = await res.json();
		return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** Expiry from an untrusted server body: only a finite number in the
 *  `expiresAt` field is honored (epoch ms of the absolute session expiry);
 *  anything else means the server did not report one. */
function readExpiresAt(body: Record<string, unknown>): number | undefined {
	return typeof body.expiresAt === "number" && Number.isFinite(body.expiresAt)
		? body.expiresAt
		: undefined;
}

/**
 * Fetch wrapper for authed fleet endpoints. Three jobs:
 *  1. Same-origin credentials on every request (cookie-only auth: the
 *     HttpOnly omp_session cookie IS the credential; no bearer tokens here).
 *  2. Adds the session-bound CSRF header on mutations (anything but
 *     GET/HEAD) when a token is cached. Without one the request still goes
 *     out and the server rejects it (surfaced by the caller) rather than the
 *     client guessing.
 *  3. A 401 answer means the session cookie is dead: transitions to
 *     signedOut (notifying listeners → sign-in modal) and drops the stale
 *     CSRF token. The Response is returned either way; callers decide.
 */
export async function authedFetch(
	input: string | URL | Request,
	init: RequestInit = {},
): Promise<Response> {
	const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
	const mutating = method !== "GET" && method !== "HEAD";
	const headers = new Headers(
		init.headers ?? (input instanceof Request ? input.headers : undefined),
	);
	if (mutating && csrf !== null) headers.set(CSRF_HEADER, csrf);
	return fetch(input, {
		...init,
		headers,
		credentials: init.credentials ?? "same-origin",
	}).then((res) => {
		if (res.status === 401) {
			csrf = null;
			transition("signedOut");
		}
		return res;
	});
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Probe the current session: GET /auth/session. 200 → signedIn (caches the
 * answer's CSRF token + expiry); 401 → signedOut (authedFetch performs the
 * transition); any other failure throws AuthError.
 */
export async function checkSession(): Promise<AuthSnapshot> {
	const res = await authedFetch("/auth/session");
	if (res.status === 401) return snapshot();
	if (!res.ok) throw await readAuthError(res, "session check");
	const body = await readJsonObject(res);
	csrf = typeof body.csrfToken === "string" ? body.csrfToken : res.headers.get(CSRF_HEADER);
	transition("signedIn", readExpiresAt(body));
	return snapshot();
}

/**
 * Exchange an access token for a session: POST /auth/login. The token is
 * used exactly once here and never stored; success leaves only the
 * server-issued HttpOnly cookie and the in-memory CSRF token. 401/403 throw
 * AuthError (typically `unauthorized`/`forbidden`); the sign-in modal shows
 * the message.
 */
export async function signIn(accessToken: string): Promise<AuthSnapshot> {
	const res = await authedFetch("/auth/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ accessToken }),
	});
	if (!res.ok) throw await readAuthError(res, "sign-in");
	const body = await readJsonObject(res);
	csrf = typeof body.csrfToken === "string" ? body.csrfToken : res.headers.get(CSRF_HEADER);
	transition("signedIn", readExpiresAt(body));
	return snapshot();
}

/**
 * POST /auth/logout (with the cached CSRF header). The tab signs out
 * locally the moment the user asks; the POST is best-effort cookie
 * invalidation and its failure never restores signed-in state (re-run
 * checkSession() to re-establish server truth).
 */
export async function signOut(): Promise<void> {
	const hadCsrf = csrf;
	transition("signedOut");
	csrf = null;
	try {
		await authedFetch("/auth/logout", {
			method: "POST",
			headers: hadCsrf !== null ? { [CSRF_HEADER]: hadCsrf } : undefined,
		});
	} catch {
		// Best-effort; see the doc comment.
	}
}
