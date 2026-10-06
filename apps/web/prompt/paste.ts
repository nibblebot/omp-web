import { createSignal, type Accessor } from "solid-js";
import type { ImageArg } from "#lib/wire/protocol";
import { loadDraft, saveDraft, type DraftBody, type DraftKey } from "../store/drafts";

/**
 * P2 paste/attachment helpers (G03). Pure functions + one composer hook, so
 * tests drive them without DOM. Payloads are preserved EXACTLY (folding is
 * visual only); validation mirrors SDK/model gates (type + size).
 */

export const PASTE_FOLD_LINES = 30;
export const PASTE_FOLD_CHARS = 4000;
/** Model attachment gate: images must be image/* and bounded (~10MB each). */
export const IMAGE_MIME_RE = /^image\/(png|jpeg|gif|webp|avif|bmp|svg\+xml)$/;
export const MAX_IMAGE_BYTES = 10_000_000;
/** Generic file attachments (external-edit import, drop): text-ish only, bounded. */
export const MAX_FILE_BYTES = 1_000_000;
const TEXT_EXT_RE =
	/\.(txt|md|markdown|json|jsonl|yml|yaml|toml|xml|csv|log|diff|patch|ts|tsx|js|jsx|py|rs|go|sh|css|html)$/i;

/** Should this paste fold visually? Payload untouched; caller shows the
 *  folded view with a raw-paste toggle. */
export function shouldFoldPaste(text: string): boolean {
	return text.split("\n").length > PASTE_FOLD_LINES || text.length > PASTE_FOLD_CHARS;
}

/** Folded preview: first N lines + omission marker. Never used for submit —
 *  submit always uses the full text. */
export function foldedPreview(text: string): {
	head: string;
	omittedLines: number;
	omittedChars: number;
} {
	const lines = text.split("\n");
	if (lines.length <= PASTE_FOLD_LINES && text.length <= PASTE_FOLD_CHARS) {
		return { head: text, omittedLines: 0, omittedChars: 0 };
	}
	const headLines = lines.slice(0, PASTE_FOLD_LINES);
	let head = headLines.join("\n");
	if (head.length > PASTE_FOLD_CHARS) head = head.slice(0, PASTE_FOLD_CHARS);
	const omittedLines = Math.max(0, lines.length - headLines.length);
	const omittedChars = Math.max(0, text.length - head.length);
	return { head, omittedLines, omittedChars };
}

export interface ImageValidation {
	ok: boolean;
	reason?: string;
}

/** SDK/model validation for clipboard/dropped images. */
export function validateImage(mimeType: string, bytes: number): ImageValidation {
	if (!IMAGE_MIME_RE.test(mimeType))
		return { ok: false, reason: `Unsupported image type ${mimeType}.` };
	if (bytes > MAX_IMAGE_BYTES) return { ok: false, reason: "Image is too large (over ~10MB)." };
	if (bytes === 0) return { ok: false, reason: "Empty image." };
	return { ok: true };
}

export interface FileValidation {
	ok: boolean;
	reason?: string;
}

/** Intentional file import gate (input/drop): permitted text-ish types,
 *  bounded size; never executes, never reads arbitrary paths. */
export function validateImportFile(name: string, mimeType: string, bytes: number): FileValidation {
	if (bytes > MAX_FILE_BYTES) return { ok: false, reason: `"${name}" is too large (over ~1MB).` };
	if (bytes === 0) return { ok: false, reason: `"${name}" is empty.` };
	const textMime =
		mimeType.startsWith("text/") || mimeType === "application/json" || mimeType === "";
	if (textMime || TEXT_EXT_RE.test(name)) return { ok: true };
	return { ok: false, reason: `"${name}" is not a text file the composer accepts.` };
}

/** Read a File/Blob as base64 (images) or text (imports). */
export function readFileAsDataUrl(file: Blob): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const reader = new FileReader();
	reader.onload = () => resolve(String(reader.result));
	reader.onerror = () => reject(reader.error ?? new Error("read failed"));
	reader.readAsDataURL(file);
	return promise;
}

export function readFileAsText(file: Blob): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const reader = new FileReader();
	reader.onload = () => resolve(String(reader.result));
	reader.onerror = () => reject(reader.error ?? new Error("read failed"));
	reader.readAsText(file);
	return promise;
}

export interface ExternalEditDiff {
	before: string;
	after: string;
	attachmentsKept: number;
}

/** Describe an external-edit import before it replaces the draft:
 *  attachments are preserved separately (never embedded in the text). */
export function describeExternalImport(
	before: string,
	after: string,
	images: ImageArg[],
): ExternalEditDiff {
	return { before, after, attachmentsKept: images.length };
}

/**
 * Draft persistence hook for the composer: loads the partition draft on
 * mount, debounced-saves edits, exposes recovery + quota state.
 */
export function useDraftPersistence(
	key: Accessor<DraftKey>,
	opts: { debounceMs?: number } = {},
): {
	initial: DraftBody | null;
	recovered: Accessor<DraftBody | null>;
	quotaWarn: Accessor<boolean>;
	scheduleSave: (body: DraftBody) => void;
	flushSave: (body: DraftBody) => void;
	markRecovered: (body: DraftBody | null) => void;
} {
	const initial = loadDraft(key());
	const [recovered, setRecovered] = createSignal<DraftBody | null>(null);
	const [quotaWarn, setQuotaWarn] = createSignal(false);
	let timer = 0;
	const debounceMs = opts.debounceMs ?? 400;

	const flushSave = (body: DraftBody): void => {
		if (timer !== 0) {
			window.clearTimeout(timer);
			timer = 0;
		}
		if (!saveDraft(key(), body)) setQuotaWarn(true);
	};

	const scheduleSave = (body: DraftBody): void => {
		if (timer !== 0) window.clearTimeout(timer);
		timer = window.setTimeout(() => {
			timer = 0;
			if (!saveDraft(key(), body)) setQuotaWarn(true);
		}, debounceMs);
	};

	return { initial, recovered, quotaWarn, scheduleSave, flushSave, markRecovered: setRecovered };
}
