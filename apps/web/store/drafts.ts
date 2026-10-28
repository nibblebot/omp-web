import { setPromptInsert, state } from "../state";
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

/** Stored form of the images: valid ones, at most 8, within a ~2.5MB payload budget. */
function sanitizeImages(raw: unknown): ImageArg[] {
	const images = Array.isArray(raw) ? raw.filter(isImageArg).slice(0, 8) : [];
	// Bound image payload (~2.5MB total) so one screenshot storm can't evict everything.
	let bytes = 0;
	const kept: ImageArg[] = [];
	for (const img of images) {
		bytes += img.data.length;
		if (bytes > 2_500_000) break;
		kept.push({ type: "image", data: img.data, mimeType: img.mimeType });
	}
	return kept;
}

/** The draft text as stored, or null when it must never be persisted (credential-looking). */
function sanitizeText(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	// Never persist credentials-looking blobs or audio payloads.
	if (SECRET_RE.test(raw)) return null;
	return raw.slice(0, 200_000);
}

function sanitizeBody(raw: unknown): DraftBody | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	const text = sanitizeText(o.text);
	if (text === null) return null;
	const files = sanitizeFiles(o.files);
	return {
		text,
		images: sanitizeImages(o.images),
		...(files.length > 0 ? { files } : {}),
		...(typeof o.selectionStart === "number" ? { selectionStart: o.selectionStart } : {}),
		...(typeof o.selectionEnd === "number" ? { selectionEnd: o.selectionEnd } : {}),
		updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : Date.now(),
	};
}

/**
 * Storage layout of one draft: the text and selection under `draftKey`, the images and file chips (the
 * heavy part, up to ~2.9MB) under `attachmentsKey`. Typing rewrites only the text; the attachments are
 * written when they change. Drafts stored before the split keep their images and chips inside the main
 * entry; `loadDraft` still reads them and the next save moves them.
 */
function attachmentsKey(slot: string): string {
	return `${slot}#attachments`;
}

/** What the last successful save left in storage, so an unchanged part is not written again. One slot:
 *  typing happens in one partition at a time, and holding more would pin old drafts' images. */
interface SavedDraft {
	slot: string;
	text: string;
	selectionStart: number | undefined;
	selectionEnd: number | undefined;
	/** The attachments as the composer handed them over (compared, never stored). */
	images: readonly ImageArg[];
	files: readonly TextAttachment[];
	/** Images plus chips the stored attachments hold. */
	attachmentCount: number;
}

let saved: SavedDraft | null = null;

let watchedWindow: object | null = null;

/** Another tab writing or removing this slot makes the memo wrong: it may no longer describe what storage
 *  holds, and a skipped write would leave text without its images, or attachments without a main entry.
 *  `key === null` is a `clear()`. Installed on the first save, once per window. */
function watchOtherTabs(): void {
	if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
	if (watchedWindow === window) return;
	watchedWindow = window;
	window.addEventListener("storage", (e) => {
		if (!saved) return;
		if (e.key === null || e.key === saved.slot || e.key === attachmentsKey(saved.slot))
			saved = null;
	});
}

function sameImages(a: readonly ImageArg[], b: readonly ImageArg[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	return a.every((img, i) => img.data === b[i]!.data && img.mimeType === b[i]!.mimeType);
}

function sameFiles(a: readonly TextAttachment[], b: readonly TextAttachment[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	return a.every((f, i) => {
		const o = b[i]!;
		return (
			f.id === o.id &&
			f.name === o.name &&
			f.size === o.size &&
			f.text === o.text &&
			f.error === o.error
		);
	});
}

let quotaWarned = false;

function warnQuota(): void {
	if (quotaWarned) return;
	quotaWarned = true;
	try {
		storage()?.setItem(QUOTA_WARN_KEY, String(Date.now()));
	} catch {
		// Best-effort.
	}
}

/** Persist the current unsent draft for its partition (called debounced by
 *  the composer). Writes only what changed since the last save of that
 *  partition. Warns once per session on quota failure. */
export function saveDraft(key: DraftKey, body: DraftBody): boolean {
	watchOtherTabs();
	const slot = draftKey(key);
	const text = sanitizeText(body.text);
	if (text === null) return false;
	const files = body.files ?? [];
	const prev = saved?.slot === slot ? saved : null;
	const attachmentsChanged =
		prev === null || !sameImages(prev.images, body.images) || !sameFiles(prev.files, files);
	const stored = attachmentsChanged
		? { images: sanitizeImages(body.images), files: sanitizeFiles(files) }
		: null;
	const attachmentCount = stored
		? stored.images.length + stored.files.length
		: prev!.attachmentCount;
	if (!text.trim() && attachmentCount === 0) {
		removeDraft(key);
		return true;
	}
	let ok = true;
	if (stored) {
		if (attachmentCount === 0) removeRaw(attachmentsKey(slot));
		else ok = writeRaw(attachmentsKey(slot), JSON.stringify(stored));
	}
	if (
		ok &&
		(prev === null ||
			prev.text !== text ||
			prev.selectionStart !== body.selectionStart ||
			prev.selectionEnd !== body.selectionEnd)
	) {
		const main = {
			text,
			...(typeof body.selectionStart === "number" ? { selectionStart: body.selectionStart } : {}),
			...(typeof body.selectionEnd === "number" ? { selectionEnd: body.selectionEnd } : {}),
			updatedAt: body.updatedAt,
		};
		ok = writeRaw(slot, JSON.stringify(main));
	}
	if (!ok) {
		// Unknown what landed: the next save writes everything again.
		saved = null;
		warnQuota();
		return false;
	}
	saved = {
		slot,
		text,
		selectionStart: body.selectionStart,
		selectionEnd: body.selectionEnd,
		images: body.images,
		files,
		attachmentCount,
	};
	return true;
}

/** Load the unsent draft for a partition; null when none (or rejected). Also
 *  drops the retired cleared-draft rings, which can hold images and would
 *  otherwise keep eating the quota live drafts need. */
export function loadDraft(key: DraftKey): DraftBody | null {
	dropLegacyClearedRings();
	const slot = draftKey(key);
	const raw = readRaw(slot);
	if (!raw) return null;
	try {
		const main = JSON.parse(raw) as Record<string, unknown>;
		const attachments = readRaw(attachmentsKey(slot));
		if (attachments && main && typeof main === "object") {
			const parsed = JSON.parse(attachments) as { images?: unknown; files?: unknown };
			main.images ??= parsed.images;
			main.files ??= parsed.files;
		}
		return sanitizeBody(main);
	} catch {
		return null;
	}
}

/** A debounced save not yet written: its timer and what it will store. */
interface PendingSave {
	timer: number;
	key: DraftKey;
	body: DraftBody;
}

/** Pending debounced saves, keyed by the `draftKey(key)` slot string. Owned
 *  here (not in the composer) so the submit path can cancel a save that
 *  closed over pre-send text before it refills the live slot. */
const pendingSaves = new Map<string, PendingSave>();

/** Debounced `saveDraft`: cancels any prior pending save for the same slot,
 *  then persists `body` after `delayMs` (default 400ms). Fire-and-forget:
 *  quota failure is recorded once per session by `saveDraft` itself. */
export function scheduleDraftSave(key: DraftKey, body: DraftBody, delayMs = 400): void {
	const slot = draftKey(key);
	const prior = pendingSaves.get(slot);
	if (prior !== undefined) window.clearTimeout(prior.timer);
	const timer = window.setTimeout(() => {
		pendingSaves.delete(slot);
		saveDraft(key, body);
	}, delayMs);
	pendingSaves.set(slot, { timer, key, body });
}

/** Cancel a pending scheduled save for the slot; storage untouched. */
export function cancelScheduledDraftSave(key: DraftKey): void {
	const slot = draftKey(key);
	const pending = pendingSaves.get(slot);
	if (pending !== undefined) {
		window.clearTimeout(pending.timer);
		pendingSaves.delete(slot);
	}
}

/** Write every pending debounced save now. The page may be killed without another
 *  event once it is backgrounded (Android discards tabs), so an edit made inside the
 *  debounce window must not wait for its timer. */
export function flushPendingDraftSaves(): void {
	for (const [slot, pending] of [...pendingSaves]) {
		window.clearTimeout(pending.timer);
		pendingSaves.delete(slot);
		saveDraft(pending.key, pending.body);
	}
}

if (typeof document !== "undefined") {
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") flushPendingDraftSaves();
	});
	window.addEventListener("pagehide", flushPendingDraftSaves);
}

/** Delete the live slot (sent: nothing is kept). Pair with
 *  `cancelScheduledDraftSave` on the submit path. */
export function removeDraft(key: DraftKey): void {
	const slot = draftKey(key);
	removeRaw(slot);
	removeRaw(attachmentsKey(slot));
	if (saved?.slot === slot) saved = null;
}

/** Partition changed (session/branch/agent/focus switch): stash the leaving
 *  composer's unsent text so returning restores it, without sending. */
export function stashUnsent(text = "", images: ImageArg[] = []): void {
	if (!text.trim() && images.length === 0) return;
	setPromptInsert({ text, ...(images.length > 0 ? { images } : {}) });
}

/** Partition of the attached session: one slot per session process and agent
 *  session id, so switching sessions never carries the composer along. Main
 *  is always `agentId: "main"` so worker focus never overwrites it (G04 focus
 *  contract). Null while no session is attached or its id has not landed. */
export function currentDraftKey(): DraftKey | null {
	if (state.currentWorkspaceId === "" || state.sessionId === "") return null;
	return {
		origin: "local",
		sessionId: `${state.currentWorkspaceId}:${state.sessionId}`,
		branchId: "main",
		agentId: "main",
	};
}

/** Partition change in the composer: stores `leaving` (the composer's content)
 *  under `prev` and returns what the composer shows for `next`, or null to keep
 *  what it holds. `prev` is undefined on mount and null while the previous
 *  session id was pending; content typed in that window stays and is stored
 *  for `next` unless `next` already has a draft. */
export function swapDraft(
	prev: DraftKey | null | undefined,
	next: DraftKey | null,
	leaving: DraftBody,
): DraftBody | null {
	if (prev) {
		cancelScheduledDraftSave(prev);
		saveDraft(prev, leaving);
	}
	// saveDraft never stores an empty body, so a loaded draft always has content.
	const saved = next ? loadDraft(next) : null;
	if (saved) return saved;
	if (prev) return { text: "", images: [], files: [], updatedAt: Date.now() };
	if (prev === null && next) saveDraft(next, leaving);
	return null;
}
