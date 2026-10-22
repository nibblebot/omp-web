import type { ImageArg } from "./protocol";

/**
 * Display text of a tool result or partial result: the text blocks of its
 * `content` joined by newlines, or the value's JSON when it has no content
 * array. The one definition shared by the session (which sends it as a
 * running tool's partial output) and the web (which renders settled results).
 */
export function extractText(value: unknown): string {
	if (value && typeof value === "object" && "content" in value && Array.isArray(value.content)) {
		const parts: string[] = [];
		for (const c of value.content) {
			if (
				c &&
				typeof c === "object" &&
				"type" in c &&
				c.type === "text" &&
				"text" in c &&
				typeof c.text === "string"
			) {
				parts.push(c.text);
			}
		}
		return parts.join("\n");
	}
	if (value == null) return "";
	try {
		return JSON.stringify(value, null, 2) ?? "";
	} catch {
		return String(value);
	}
}

/**
 * Recursively collect image payloads from a tool result, message content, or
 * any nested value. Handles ImageContent blocks ({type:"image", data,
 * mimeType}) and provider screenshot shapes ({type:"computer_screenshot" |
 * "screenshot", image_url: "data:<mime>;base64,..."}). Values without base64
 * data (e.g. ScreenshotResult file paths) are ignored, as is anything else.
 * A `blob:sha256:` reference is kept as is; the subagent transcript store resolves it by hash.
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
	if (
		(obj.type === "computer_screenshot" || obj.type === "screenshot") &&
		typeof obj.image_url === "string"
	) {
		const m = /^data:([^;,]+);base64,(.+)$/s.exec(obj.image_url);
		if (m) out.push({ type: "image", data: m[2], mimeType: m[1] });
		return out;
	}
	for (const v of Object.values(obj)) scanImages(v, out);
	return out;
}
