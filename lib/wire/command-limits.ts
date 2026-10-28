const MIB = 1024 * 1024;

/**
 * Hard cap on one browser command's JSON body as forwarded over the callback
 * pair (32 MiB). It fits two full-size images (MAX_IMAGE_BYTES decoded, about
 * 13.3 MB base64 each) plus text. The composer has no image-count or total
 * size limit, so a prompt over the cap is refused by name, not silently.
 * Enforced by the web before sending and by the fleet edge before forwarding.
 * A command over the cap fails only its own call (`payload_too_large`).
 */
export const MAX_COMMAND_BYTES = 32 * MIB;

/** UTF-8 byte length of a command's JSON body, as forwarded. */
export function commandBytes(command: unknown): number {
	return new TextEncoder().encode(JSON.stringify(command)).byteLength;
}

/** User-readable refusal for a command of `bytes` over `limit` bytes. */
export function commandTooLargeMessage(bytes: number, limit: number): string {
	return `this request is ${(bytes / MIB).toFixed(1)} MiB, over the ${(limit / MIB).toFixed(1)} MiB per-message limit; send fewer or smaller images in one message and try again`;
}

/** Chars per encodeInto pass of {@link utf8ByteLength}; 3 UTF-8 bytes per UTF-16 unit at most, so the scratch below always fits one pass. */
const UTF8_COUNT_CHUNK_CHARS = 16_384;
const utf8CountScratch = new Uint8Array(UTF8_COUNT_CHUNK_CHARS * 3);
const utf8CountEncoder = new TextEncoder();

/**
 * Exact UTF-8 byte length of `text`, counted through a small reusable scratch
 * buffer instead of encoding a payload-sized copy (a two-image prompt is tens
 * of MB; `encode(text).byteLength` allocated and filled that copy on the
 * Enter-to-socket path).
 */
export function utf8ByteLength(text: string): number {
	let bytes = 0;
	for (let start = 0; start < text.length;) {
		let end = Math.min(text.length, start + UTF8_COUNT_CHUNK_CHARS);
		if (end < text.length) {
			// Never split a surrogate pair: a lone half would encode as U+FFFD (3 bytes, not 2).
			const last = text.charCodeAt(end - 1);
			if (last >= 0xd800 && last <= 0xdbff) end--;
		}
		bytes += utf8CountEncoder.encodeInto(text.slice(start, end), utf8CountScratch).written;
		start = end;
	}
	return bytes;
}
