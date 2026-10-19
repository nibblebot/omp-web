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
