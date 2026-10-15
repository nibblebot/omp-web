/** `N→` / `N│` / `N:` prefix the SDK adds to numbered read output. */
export const LINE_NUMBER = /^\s*\d+\s*[→|:]\s?/;

/**
 * Whether the read output carries SDK line numbers: a majority of non-empty
 * lines match `LINE_NUMBER`. Hashline edit mode always numbers; otherwise
 * numbering follows `readLineNumbers`.
 */
export function hasLineNumbers(output: string): boolean {
	const lines = output.split("\n").filter((line) => line.trim().length > 0);
	if (lines.length === 0) return false;
	const matched = lines.filter((line) => LINE_NUMBER.test(line)).length;
	return matched / lines.length > 0.6;
}

/**
 * Extensions the SDK converts to Markdown with markit (SDK utils/markit.ts:22).
 * Copied because the web cannot import SDK modules.
 */
const MARKIT_EXTENSIONS: Record<string, true> = {
	".pdf": true,
	".docx": true,
	".pptx": true,
	".xlsx": true,
	".epub": true,
};

/** Whether `path` is a document the SDK converts to Markdown (read.ts:2051). */
export function isMarkitDocument(path: string): boolean {
	const dot = path.lastIndexOf(".");
	if (dot < 0) return false;
	return MARKIT_EXTENSIONS[path.slice(dot).toLowerCase()] === true;
}
