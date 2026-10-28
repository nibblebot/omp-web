import { createSignal, type Accessor } from "solid-js";
import { loadDraft, saveDraft, type DraftBody, type DraftKey } from "../store/drafts";
import { MAX_IMAGE_BYTES } from "#lib/wire/image-limits";

/**
 * P2 paste/attachment helpers (G03). Pure functions + one composer hook, so
 * tests drive them without DOM. Payloads are preserved EXACTLY (folding is
 * visual only); validation mirrors SDK/model gates (type + size).
 */

export const PASTE_FOLD_LINES = 30;
export const PASTE_FOLD_CHARS = 4000;
/** Model attachment gate: images must be image/* and bounded (~10MB each). */
export const IMAGE_MIME_RE = /^image\/(png|jpeg|gif|webp|avif|bmp|svg\+xml)$/;
const IMAGE_FORMATS = "PNG, JPEG, GIF, WebP, AVIF, BMP or SVG";
/** Generic file attachments (external-edit import, drop): text-ish only, bounded. */
export const MAX_FILE_BYTES = 1_000_000;
const TEXT_EXTENSIONS = [
	"txt",
	"md",
	"markdown",
	"json",
	"jsonl",
	"yml",
	"yaml",
	"toml",
	"xml",
	"csv",
	"log",
	"diff",
	"patch",
	"ts",
	"tsx",
	"js",
	"jsx",
	"py",
	"rs",
	"go",
	"sh",
	"css",
	"html",
];
const TEXT_EXT_RE = new RegExp(`\\.(${TEXT_EXTENSIONS.join("|")})$`, "i");
/** `accept` for the attach button: images plus every text type the gate permits. */
export const ATTACH_ACCEPT = `image/*,${TEXT_EXTENSIONS.map((ext) => `.${ext}`).join(",")}`;

/** SDK default for `paste.largeMenuThreshold` (lines). */
export const PASTE_LARGE_MENU_DEFAULT = 100;

/** Should this paste fold visually? Folds at `threshold` lines, matching the TUI
 *  large-paste menu; 0 disables. Payload untouched; caller shows the folded view
 *  with a raw-paste toggle. */
export function shouldFoldPaste(text: string, threshold: number): boolean {
	return threshold > 0 && text.split("\n").length >= threshold;
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

/** Refusal for an image whose type is not attachable and could not be converted. */
export function unsupportedImageReason(label: string, mimeTypes: readonly string[]): string {
	const types = mimeTypes.map((type) => type || "an unknown type").join(" / ");
	return `${label} can't be attached: ${types} is not supported and the browser could not convert it. Use ${IMAGE_FORMATS}.`;
}

/** SDK/model validation for clipboard/dropped images. `label` names the image in the refusal. */
export function validateImage(mimeType: string, bytes: number, label = "Image"): ImageValidation {
	if (!IMAGE_MIME_RE.test(mimeType))
		return { ok: false, reason: unsupportedImageReason(label, [mimeType]) };
	if (bytes > MAX_IMAGE_BYTES)
		return {
			ok: false,
			reason: `${label} is ${(bytes / 1_000_000).toFixed(1)} MB; the limit is ${MAX_IMAGE_BYTES / 1_000_000} MB per image.`,
		};
	if (bytes === 0) return { ok: false, reason: `${label} is empty.` };
	return { ok: true };
}

/**
 * Images to take from one paste. The clipboard holds one capture offered in several encodings
 * (image/png beside image/tiff, image/x-qt-image, ...), so supported types are attached and
 * unsupported ones are alternates; with none supported, `convert` lists the candidates to try in
 * order, attaching only the first that converts.
 */
export function clipboardImageCandidates<T extends { type: string }>(
	items: readonly T[],
): { attach: T[]; convert: T[] } {
	const attach = items.filter((item) => IMAGE_MIME_RE.test(item.type));
	return attach.length > 0 ? { attach, convert: [] } : { attach, convert: [...items] };
}

/** Raster types an oversize image is re-encoded from: GIF would lose its animation and SVG is not pixels. */
const DOWNSCALE_MIME_RE = /^image\/(png|jpeg|webp)$/;
/** Re-encodes tried before giving up; each shrinks the sides a further 30%. */
const DOWNSCALE_ATTEMPTS = 4;

/**
 * Per-side scale that brings an image of `bytes` under `limit`: encoded size follows pixel
 * count, so each side scales by the square root of the size ratio, with 20% headroom for
 * the JPEG re-encode not being exactly proportional. 1 when it already fits.
 */
export function downscaleFactor(bytes: number, limit: number = MAX_IMAGE_BYTES): number {
	return bytes <= limit ? 1 : Math.sqrt((limit * 0.8) / bytes);
}

/** Re-encode a photo-sized raster as JPEG, shrinking it until it fits the per-image limit. */
async function downscaleImage(file: Blob): Promise<Blob> {
	const bitmap = await createImageBitmap(file);
	try {
		let scale = downscaleFactor(file.size);
		for (let attempt = 0; attempt < DOWNSCALE_ATTEMPTS; attempt++) {
			const width = Math.max(1, Math.round(bitmap.width * scale));
			const height = Math.max(1, Math.round(bitmap.height * scale));
			const canvas = new OffscreenCanvas(width, height);
			const context = canvas.getContext("2d");
			if (!context) throw new Error("2d canvas unavailable");
			// JPEG has no alpha: a transparent PNG would turn black.
			context.fillStyle = "#fff";
			context.fillRect(0, 0, width, height);
			context.drawImage(bitmap, 0, 0, width, height);
			const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
			if (blob.size <= MAX_IMAGE_BYTES) return blob;
			scale *= 0.7;
		}
		throw new Error("image could not be shrunk under the size limit");
	} finally {
		bitmap.close();
	}
}

/**
 * Base64 payload of an image the model accepts: a supported type is read as is, anything else the
 * browser decodes (TIFF in Safari, ICO, type aliases like image/x-png) is re-encoded as PNG. A
 * PNG, JPEG or WebP over the per-image limit (a phone camera photo) is downscaled to a JPEG
 * instead of refused; when that fails the original is read and `validateImage` refuses it.
 * Rejects when the browser cannot decode it.
 */
export async function readImagePayload(file: Blob): Promise<{ data: string; mimeType: string }> {
	if (IMAGE_MIME_RE.test(file.type)) {
		if (file.size > MAX_IMAGE_BYTES && DOWNSCALE_MIME_RE.test(file.type)) {
			try {
				file = await downscaleImage(file);
			} catch {
				// Undecodable or still too large: read as is and let validation refuse it.
			}
		}
		const url = await readFileAsDataUrl(file);
		return { data: url.slice(url.indexOf(",") + 1), mimeType: file.type };
	}
	const bitmap = await createImageBitmap(file);
	try {
		const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
		const context = canvas.getContext("2d");
		if (!context) throw new Error("2d canvas unavailable");
		context.drawImage(bitmap, 0, 0);
		return await readImagePayload(await canvas.convertToBlob({ type: "image/png" }));
	} finally {
		bitmap.close();
	}
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
