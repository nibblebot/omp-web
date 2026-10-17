/**
 * Per-image size limit shared by the web composer and the daemon queue, so an
 * image accepted by the composer is never refused by a queue that holds it.
 */
export const MAX_IMAGE_BYTES = 10_000_000;

/** Decoded byte length of a base64 image payload. */
export function imageDecodedBytes(base64: string): number {
	return Math.floor((base64.length * 3) / 4);
}

/** Refusal text for the first image over the limit, or undefined when every image fits. */
export function oversizedImageNotice(
	images: ReadonlyArray<{ data: string }> | undefined,
): string | undefined {
	if (!images?.some((image) => imageDecodedBytes(image.data) > MAX_IMAGE_BYTES)) return undefined;
	return `Image is too large to queue (over ${MAX_IMAGE_BYTES / 1_000_000} MB). Attach a smaller image.`;
}
