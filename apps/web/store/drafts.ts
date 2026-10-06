import { setPromptInsert } from "../state";
import type { ImageArg } from "#lib/wire/protocol";

/**
 * P2 draft ownership (G03). Browser-persisted unsent drafts, partitioned by
 * fleet-origin/session/branch/agent so Main is preserved on focus changes
 * and concurrent tabs/sessions never clobber each other.
 *
 * - Unsent drafts only: submitted history stays in prompt/history.ts.
 * - Cleared drafts go to a BOUNDED recovery ring (explicit restore action).
 * - Attachments ride alongside text; raw audio/credentials are never stored.
 * - Quota failure warns instead of silently discarding.
 *
 * Storage is localStorage-backed with an in-memory fallback; every write is
 * best-effort. Server owns durable agent state; this module owns the
 * normalized browser mirror; components own transient presentation.
 */

export interface DraftBody {
	text: string;
	images: ImageArg[];
	selectionStart?: number;
	selectionEnd?: number;
	editMode?: "insert" | "normal" | "visual";
	updatedAt: number;
}

export interface DraftKey {
	origin: string;
	sessionId: string;
	branchId: string;
	agentId: string;
}

const DRAFT_PREFIX = "omp-web:draft:v2:";
const CLEARED_PREFIX = "omp-web:draft-cleared:v2:";
const CLEARED_CAP = 5;
const QUOTA_WARN_KEY = "omp-web:draft-quota-warned";

function storage(): Storage | null {
	try {
		if (typeof localStorage !== "undefined") return localStorage;
	} catch {
		return null;
	}
	return null;
}

const memFallback = new Map<string, string>();

function readRaw(key: string): string | null {
	const s = storage();
	try {
		if (s) return s.getItem(key);
	} catch {
		return memFallback.get(key) ?? null;
	}
	return memFallback.get(key) ?? null;
}

function writeRaw(key: string, value: string): boolean {
	const s = storage();
	try {
		if (s) {
			s.setItem(key, value);
			return true;
		}
		memFallback.set(key, value);
		return true;
	} catch {
		return false;
	}
}

function removeRaw(key: string): void {
	const s = storage();
	try {
		if (s) s.removeItem(key);
	} catch {
		// Best-effort.
	}
	memFallback.delete(key);
}

export function draftKey(k: DraftKey): string {
	return `${DRAFT_PREFIX}${k.origin}¦${k.sessionId}¦${k.branchId}¦${k.agentId}`;
}

function clearedKey(k: DraftKey): string {
	return `${CLEARED_PREFIX}${k.origin}¦${k.sessionId}¦${k.branchId}¦${k.agentId}`;
}

function isImageArg(v: unknown): v is ImageArg {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	return o.type === "image" && typeof o.data === "string" && typeof o.mimeType === "string";
}

function sanitizeBody(raw: unknown): DraftBody | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	if (typeof o.text !== "string") return null;
	// Never persist credentials-looking blobs or audio payloads.
	if (/sk-ant-|sk-[a-zA-Z0-9]{8,}|xox[bap]-|ghp_|Bearer\s+[A-Za-z0-9._~-]{8,}/.test(o.text))
		return null;
	const images = Array.isArray(o.images) ? o.images.filter(isImageArg).slice(0, 8) : [];
	// Bound image payload (~2.5MB total) so one screenshot storm can't evict everything.
	let bytes = 0;
	const kept: ImageArg[] = [];
	for (const img of images) {
		bytes += img.data.length;
		if (bytes > 2_500_000) break;
		kept.push({ type: "image", data: img.data, mimeType: img.mimeType });
	}
	return {
		text: o.text.slice(0, 200_000),
		images: kept,
		...(typeof o.selectionStart === "number" ? { selectionStart: o.selectionStart } : {}),
		...(typeof o.selectionEnd === "number" ? { selectionEnd: o.selectionEnd } : {}),
		...(o.editMode === "insert" || o.editMode === "normal" || o.editMode === "visual"
			? { editMode: o.editMode }
			: {}),
		updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : Date.now(),
	};
}

let quotaWarned = false;

/** Persist the current unsent draft for its partition (called debounced by
 *  the composer). Warns once per session on quota failure. */
export function saveDraft(key: DraftKey, body: DraftBody): boolean {
	const clean = sanitizeBody(body);
	if (!clean) return false;
	if (!clean.text.trim() && clean.images.length === 0) {
		removeRaw(draftKey(key));
		return true;
	}
	if (!writeRaw(draftKey(key), JSON.stringify(clean))) {
		if (!quotaWarned) {
			quotaWarned = true;
			try {
				storage()?.setItem(QUOTA_WARN_KEY, String(Date.now()));
			} catch {
				// Best-effort.
			}
		}
		return false;
	}
	return true;
}

/** Load the unsent draft for a partition; null when none (or rejected). */
export function loadDraft(key: DraftKey): DraftBody | null {
	const raw = readRaw(draftKey(key));
	if (!raw) return null;
	try {
		return sanitizeBody(JSON.parse(raw));
	} catch {
		return null;
	}
}

/** Pending debounced saves, keyed by the `draftKey(key)` slot string. Owned
 *  here (not in the composer) so the submit/discard paths can cancel a save
 *  that closed over pre-send text before it refills the live slot. */
const pendingTimers = new Map<string, number>();

/** Debounced `saveDraft`: cancels any prior pending save for the same slot,
 *  then persists `body` after `delayMs` (default 400ms). Fire-and-forget:
 *  quota failure is recorded once per session by `saveDraft` itself. */
export function scheduleDraftSave(key: DraftKey, body: DraftBody, delayMs = 400): void {
	const slot = draftKey(key);
	const prior = pendingTimers.get(slot);
	if (prior !== undefined) window.clearTimeout(prior);
	pendingTimers.set(
		slot,
		window.setTimeout(() => {
			pendingTimers.delete(slot);
			saveDraft(key, body);
		}, delayMs),
	);
}

/** Cancel a pending scheduled save for the slot; storage untouched. */
export function cancelScheduledDraftSave(key: DraftKey): void {
	const slot = draftKey(key);
	const pending = pendingTimers.get(slot);
	if (pending !== undefined) {
		window.clearTimeout(pending);
		pendingTimers.delete(slot);
	}
}

/** Delete the live slot without touching the cleared ring (sent, not
 *  discarded: no recovery entry). Pair with `cancelScheduledDraftSave` on
 *  the submit path. */
export function removeDraft(key: DraftKey): void {
	removeRaw(draftKey(key));
}

/** Explicit destructive clear: the current draft moves to the bounded
 *  cleared ring (recoverable), then the live slot is removed. */
export function clearDraft(key: DraftKey): DraftBody | null {
	const live = loadDraft(key);
	const ck = clearedKey(key);
	let ring: DraftBody[] = [];
	try {
		const raw = readRaw(ck);
		if (raw) {
			const parsed: unknown = JSON.parse(raw);
			if (Array.isArray(parsed))
				ring = parsed.map(sanitizeBody).filter((b): b is DraftBody => b !== null);
		}
	} catch {
		ring = [];
	}
	if (live) {
		ring = [...ring, live].slice(-CLEARED_CAP);
		writeRaw(ck, JSON.stringify(ring));
	}
	removeRaw(draftKey(key));
	return live;
}

/** Most recently cleared draft in this partition, if any. */
export function peekClearedDraft(key: DraftKey): DraftBody | null {
	try {
		const raw = readRaw(clearedKey(key));
		if (!raw) return null;
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed) || parsed.length === 0) return null;
		return sanitizeBody(parsed[parsed.length - 1]) ?? null;
	} catch {
		return null;
	}
}

/** Explicit recovery action: pop the newest cleared draft back into the
 *  composer's inbox (unsent) and remove it from the ring. */
export function recoverClearedDraft(key: DraftKey): DraftBody | null {
	const ck = clearedKey(key);
	let ring: DraftBody[] = [];
	try {
		const raw = readRaw(ck);
		if (raw) {
			const parsed: unknown = JSON.parse(raw);
			if (Array.isArray(parsed))
				ring = parsed.map(sanitizeBody).filter((b): b is DraftBody => b !== null);
		}
	} catch {
		return null;
	}
	const top = ring.pop() ?? null;
	if (!top) return null;
	writeRaw(ck, JSON.stringify(ring));
	setPromptInsert({ text: top.text, ...(top.images.length > 0 ? { images: top.images } : {}) });
	return top;
}

/** Drop the cleared ring without restoring (retention/deletion control). */
export function deleteClearedDrafts(key: DraftKey): void {
	removeRaw(clearedKey(key));
}

/** Partition changed (session/branch/agent/focus switch): stash the leaving
 *  composer's unsent text so returning restores it, without sending. */
export function stashUnsent(text = "", images: ImageArg[] = []): void {
	if (!text.trim() && images.length === 0) return;
	setPromptInsert({ text, ...(images.length > 0 ? { images } : {}) });
}

/** Default partition for the currently attached session. Branch/agent refine
 *  it when known; Main is always `agentId: "main"` so worker focus never
 *  overwrites it (G04 focus contract). */
export function currentDraftKey(
	opts: {
		origin?: string;
		sessionId?: string;
		branchId?: string;
		agentId?: string;
	} = {},
): DraftKey {
	return {
		origin: opts.origin ?? "local",
		sessionId: opts.sessionId ?? "",
		branchId: opts.branchId ?? "main",
		agentId: opts.agentId ?? "main",
	};
}
