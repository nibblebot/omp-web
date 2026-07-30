import DOMPurify from "dompurify";
import { marked } from "marked";

// Sanitization is mandatory — model output can contain raw HTML.
export function renderMarkdown(src: string): string {
	return DOMPurify.sanitize(marked.parse(src, { async: false }));
}

/**
 * Splits a streaming markdown source into frozen paragraphs (parsed once) and
 * a live tail (re-parsed per frame). Blank lines split ONLY outside fenced
 * code blocks. When `final` is true, everything is complete.
 */
export function splitForStreaming(src: string, final: boolean): { complete: string[]; tail: string } {
	if (final) return { complete: src ? [src] : [], tail: "" };
	const lines = src.split("\n");
	const complete: string[] = [];
	let inFence = false;
	let segStart = 0;
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trimStart();
		if (trimmed === "" && !inFence) {
			const chunk = lines.slice(segStart, i).join("\n");
			if (chunk.trim() !== "") complete.push(chunk);
			segStart = i + 1;
			continue;
		}
		if (trimmed.startsWith("```")) inFence = !inFence;
	}
	return { complete, tail: lines.slice(segStart).join("\n") };
}
