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

/** Base64 payload to bytes. Throws on malformed input. */
function decodeBase64(data: string): Uint8Array<ArrayBuffer> {
	const native = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array<ArrayBuffer> })
		.fromBase64;
	if (native) return native.call(Uint8Array, data);
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

interface ImageUrlEntry {
	/** Content key, `mimeType|length|hash`. */
	key: string;
	mimeType: string;
	length: number;
	url: string;
	/** Decoded size, what the byte budget counts. */
	bytes: number;
	/** False once evicted and revoked. */
	live: boolean;
}

/** 64-bit content hash of a base64 payload (cyrb53-style, two 32-bit lanes), as 13 base-36 digits. */
function hashPayload(data: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < data.length; i++) {
		const c = data.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 2654435761);
		h2 = Math.imul(h2 ^ c, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

/** Decoded image bytes the default cache keeps registered as blobs before it evicts the least recently used. */
const IMAGE_URL_CACHE_MAX_BYTES = 96 * 1024 * 1024;
/** An evicted URL stays valid this long: an <img> mounted in the same turn may not have started its fetch yet. */
const REVOKE_GRACE_MS = 5_000;

/**
 * Object-URL cache for image payloads. The src is a short `blob:` URL, so the <img> holds neither a data:
 * URL copy of the screenshot nor does the cache keep the base64 alive: entries are keyed by a content hash,
 * never by the payload string itself. Tool streaming re-scans the same screenshot into fresh ImageArg
 * objects on every flush, so equal content must map to the same URL (the <img> src never changes between
 * renders and the browser never re-decodes the screenshot); an object already seen is answered from a
 * WeakMap without touching its payload, and only a new object pays the one hash. The cache is LRU and
 * bounded by decoded bytes; eviction revokes the URL, freeing the blob.
 */
export function createImageUrlCache(
	maxBytes: number,
	revokeDelayMs: number,
): (img: ImageArg) => string {
	const byContent = new Map<string, ImageUrlEntry>();
	const byObject = new WeakMap<ImageArg, ImageUrlEntry>();
	let bytes = 0;

	const touch = (entry: ImageUrlEntry): void => {
		byContent.delete(entry.key);
		byContent.set(entry.key, entry);
	};

	return (img) => {
		const { data, mimeType } = img;
		const seen = byObject.get(img);
		// An ImageArg is mutated in place when a subagent image resolves; length and type guard that.
		if (seen?.live && seen.length === data.length && seen.mimeType === mimeType) {
			touch(seen);
			return seen.url;
		}
		const key = `${mimeType}|${data.length}|${hashPayload(data)}`;
		const hit = byContent.get(key);
		if (hit !== undefined) {
			byObject.set(img, hit);
			touch(hit);
			return hit.url;
		}
		let url: string;
		let size: number;
		try {
			const decoded = decodeBase64(data);
			size = decoded.byteLength;
			url = URL.createObjectURL(new Blob([decoded], { type: mimeType }));
		} catch {
			// Not decodable: the browser shows its broken-image state, as it did for a bad data: URL.
			return `data:${mimeType};base64,${data}`;
		}
		const entry: ImageUrlEntry = {
			key,
			mimeType,
			length: data.length,
			url,
			bytes: size,
			live: true,
		};
		byContent.set(key, entry);
		byObject.set(img, entry);
		bytes += size;
		for (const [oldestKey, oldest] of byContent) {
			if (bytes <= maxBytes || oldest === entry) break;
			byContent.delete(oldestKey);
			bytes -= oldest.bytes;
			oldest.live = false;
			setTimeout(() => URL.revokeObjectURL(oldest.url), revokeDelayMs);
		}
		return url;
	};
}

/** Stable `blob:` URL for an image payload, for an <img> src. */
export const imageObjectUrl = createImageUrlCache(IMAGE_URL_CACHE_MAX_BYTES, REVOKE_GRACE_MS);
