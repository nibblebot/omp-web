import type { ImageArg } from "./protocol";

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

/** data: URL for an image payload. */
export function imageDataUrl(img: ImageArg): string {
	return `data:${img.mimeType};base64,${img.data}`;
}
