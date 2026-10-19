import { setPromptInsert } from "../state";
import type { ImageArg } from "#lib/wire/protocol";
import type { TextAttachment } from "../prompt/attachments";

/**
 * P2 draft ownership (G03). Browser-persisted unsent drafts, partitioned by
 * fleet-origin/session/branch/agent so Main is preserved on focus changes
 * and concurrent tabs/sessions never clobber each other.
 *
 * - Unsent drafts only: submitted history stays in prompt/history.ts.
 * - Drafts are live only: sending removes the stored slot.
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
	/** Attached text-file chips. The stored copy is budgeted; see `unsavedFileIds`. */
	files?: TextAttachment[];
	selectionStart?: number;
	selectionEnd?: number;
	updatedAt: number;
}

export interface DraftKey {
	origin: string;
	sessionId: string;
	branchId: string;
	agentId: string;
}

const DRAFT_PREFIX = "omp-web:draft:v2:";
/** Retired cleared-draft ring keys; only used to sweep them from storage. */
const LEGACY_CLEARED_PREFIX = "omp-web:draft-cleared:v2:";
const QUOTA_WARN_KEY = "omp-web:draft-quota-warned";
/** Total file text one stored draft keeps; larger chips stay in memory only. */
const DRAFT_FILES_MAX_CHARS = 400_000;
const FILE_NOT_KEPT = "Not kept with the draft; attach it again.";
const SECRET_RE = /sk-ant-|sk-[a-zA-Z0-9]{8,}|xox[bap]-|ghp_|Bearer\s+[A-Za-z0-9._~-]{8,}/;

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

/** Remove stored keys of the retired cleared-draft ring (they can hold images
 *  and eat the quota live drafts need). Runs on each draft load, not per
 *  keystroke; the in-memory fallback never outlives a page, so it holds none. */
function dropLegacyClearedRings(): void {
	const s = storage();
	if (!s) return;
	try {
		const stale: string[] = [];
		for (let i = 0; i < s.length; i++) {
			const k = s.key(i);
			if (k?.startsWith(LEGACY_CLEARED_PREFIX)) stale.push(k);
		}
		for (const k of stale) s.removeItem(k);
	} catch {
		// Best-effort.
	}
}

function isImageArg(v: unknown): v is ImageArg {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	return o.type === "image" && typeof o.data === "string" && typeof o.mimeType === "string";
}

/** Ids of the chips the stored draft cannot hold: text over the shared budget, or credential-like. */
function storableFileIds(files: readonly TextAttachment[]): Set<string> {
	const kept = new Set<string>();
	let chars = 0;
	for (const file of files) {
		if (file.text === undefined) {
			kept.add(file.id);
			continue;
		}
		if (SECRET_RE.test(file.text) || chars + file.text.length > DRAFT_FILES_MAX_CHARS) continue;
		chars += file.text.length;
		kept.add(file.id);
	}
	return kept;
}

/** Chips that stay in memory only: they are sent and restored by Undo, but a reload loses them.
 *  The composer marks these chips as not saved. */
export function unsavedFileIds(files: readonly TextAttachment[]): Set<string> {
	const kept = storableFileIds(files);
	return new Set(files.filter((f) => !kept.has(f.id)).map((f) => f.id));
}

function isTextAttachment(v: unknown): v is TextAttachment {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.id === "string" &&
		typeof o.name === "string" &&
		typeof o.size === "number" &&
		(o.text === undefined || typeof o.text === "string") &&
		(o.error === undefined || typeof o.error === "string")
	);
}

/** Stored form of the chips. A chip over budget keeps its name and reads as not kept. */
function sanitizeFiles(raw: unknown): TextAttachment[] {
	if (!Array.isArray(raw)) return [];
	const files = raw.filter(isTextAttachment);
	const kept = storableFileIds(files);
	return files.map((f) => {
		const name = f.name.slice(0, 255);
		if (!kept.has(f.id)) return { id: f.id, name, size: f.size, error: FILE_NOT_KEPT };
		return {
			id: f.id,
			name,
			size: f.size,
			...(f.text !== undefined ? { text: f.text } : {}),
			...(f.error !== undefined ? { error: f.error } : {}),
		};
	});
}

function sanitizeBody(raw: unknown): DraftBody | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	if (typeof o.text !== "string") return null;
	// Never persist credentials-looking blobs or audio payloads.
	if (SECRET_RE.test(o.text)) return null;
	const images = Array.isArray(o.images) ? o.images.filter(isImageArg).slice(0, 8) : [];
	// Bound image payload (~2.5MB total) so one screenshot storm can't evict everything.
	let bytes = 0;
	const kept: ImageArg[] = [];
	for (const img of images) {
		bytes += img.data.length;
		if (bytes > 2_500_000) break;
		kept.push({ type: "image", data: img.data, mimeType: img.mimeType });
	}
	const files = sanitizeFiles(o.files);
	return {
		text: o.text.slice(0, 200_000),
		images: kept,
		...(files.length > 0 ? { files } : {}),
		...(typeof o.selectionStart === "number" ? { selectionStart: o.selectionStart } : {}),
		...(typeof o.selectionEnd === "number" ? { selectionEnd: o.selectionEnd } : {}),
		updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : Date.now(),
	};
}

let quotaWarned = false;

/** Persist the current unsent draft for its partition (called debounced by
 *  the composer). Warns once per session on quota failure. */
export function saveDraft(key: DraftKey, body: DraftBody): boolean {
	const clean = sanitizeBody(body);
	if (!clean) return false;
	if (!clean.text.trim() && clean.images.length === 0 && !clean.files?.length) {
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

/** Load the unsent draft for a partition; null when none (or rejected). Also
 *  drops the retired cleared-draft rings, which can hold images and would
 *  otherwise keep eating the quota live drafts need. */
export function loadDraft(key: DraftKey): DraftBody | null {
	dropLegacyClearedRings();
	const raw = readRaw(draftKey(key));
	if (!raw) return null;
	try {
		return sanitizeBody(JSON.parse(raw));
	} catch {
		return null;
	}
}

/** Pending debounced saves, keyed by the `draftKey(key)` slot string. Owned
 *  here (not in the composer) so the submit path can cancel a save that
 *  closed over pre-send text before it refills the live slot. */
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

/** Delete the live slot (sent: nothing is kept). Pair with
 *  `cancelScheduledDraftSave` on the submit path. */
export function removeDraft(key: DraftKey): void {
	removeRaw(draftKey(key));
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
