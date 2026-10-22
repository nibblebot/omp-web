import type { ImageArg } from "#lib/wire/protocol";

/** A subagent transcript read raw still carries the images its session persisted to the blob store as `blob:sha256:<hash>`. */
const BLOB_REF_PATTERN = /^blob:sha256:([a-f0-9]{64})$/;

/** sha256 of the blob a not-yet-resolved image points at; undefined once its data holds real base64. */
export function imageBlobHash(img: Pick<ImageArg, "data">): string | undefined {
	return BLOB_REF_PATTERN.exec(img.data)?.[1];
}

/**
 * True while the image has no decodable bytes: its data is still a `blob:sha256:` reference (a subagent
 * transcript read raw and not yet resolved, or a blob the store no longer holds). Render a placeholder, never an <img>.
 */
export function isUnresolvedImage(img: Pick<ImageArg, "data">): boolean {
	return img.data.startsWith("blob:sha256:");
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
