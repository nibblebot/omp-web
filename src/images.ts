import type { ImageArg } from "../shared/protocol";

/**
 * Recursively collect image payloads from a tool result, message content, or
 * any nested value. Handles ImageContent blocks ({type:"image", data,
 * mimeType}) and provider screenshot shapes ({type:"computer_screenshot" |
 * "screenshot", image_url: "data:<mime>;base64,..."}). Values without base64
 * data (e.g. ScreenshotResult file paths) are ignored, as is anything else.
 */
export function scanImages(value: unknown, out: ImageArg[] = []): ImageArg[] {
	if (Array.isArray(value)) {
		for (const v of value) scanImages(v, out);
		return out;
	}
	if (!value || typeof value !== "object") return out;
	const obj = value as Record<string, unknown>;
	if (obj.type === "image" && typeof obj.data === "string" && typeof obj.mimeType === "string") {
		out.push({ type: "image", data: obj.data, mimeType: obj.mimeType });
		return out;
	}
	if ((obj.type === "computer_screenshot" || obj.type === "screenshot") && typeof obj.image_url === "string") {
		const m = /^data:([^;,]+);base64,(.+)$/s.exec(obj.image_url);
		if (m) out.push({ type: "image", data: m[2], mimeType: m[1] });
		return out;
	}
	for (const v of Object.values(obj)) scanImages(v, out);
	return out;
}

// data: URL cache. Tool streaming re-scans the same screenshot payload into
// fresh ImageArg objects on every flush, so the cache is keyed by content
// (mimeType + data) rather than object identity: identical payloads always
// yield the identical string, so the <img> src never changes between renders
// and the browser never re-decodes the screenshot. Bounded to the most
// recent 200 payloads: on overflow the oldest (first-inserted) key is
// evicted, so memory stays flat across long sessions.
const dataUrlCache = new Map<string, string>();
const DATA_URL_CACHE_CAP = 200;

/** data: URL for an image payload. */
export function imageDataUrl(img: ImageArg): string {
	const key = `data:${img.mimeType};base64,${img.data}`;
	const cached = dataUrlCache.get(key);
	if (cached !== undefined) return cached;
	dataUrlCache.set(key, key);
	// Map preserves insertion order, so the first key is the oldest entry.
	if (dataUrlCache.size > DATA_URL_CACHE_CAP) {
		dataUrlCache.delete(dataUrlCache.keys().next().value as string);
	}
	return key;
}
