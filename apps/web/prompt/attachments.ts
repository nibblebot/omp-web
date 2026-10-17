import { validateImportFile } from "./paste";

/**
 * A non-image file attached to the composer. Text is read once at attach time
 * and inlined into the outgoing message at send time (never into the draft
 * textarea). A rejected file keeps a chip with `error` set and no `text`.
 */
export interface TextAttachment {
	id: string;
	name: string;
	size: number;
	text?: string;
	error?: string;
}

let nextId = 0;

/** Read a picked, dropped or pasted file into a chip; oversize, binary and empty files become error chips. */
export async function importTextAttachment(file: File): Promise<TextAttachment> {
	nextId += 1;
	const id = `att-${Date.now().toString(36)}-${nextId}`;
	const check = validateImportFile(file.name, file.type, file.size);
	if (!check.ok) return { id, name: file.name, size: file.size, error: check.reason };
	return { id, name: file.name, size: file.size, text: await file.text() };
}

/**
 * Append each readable text attachment to the typed text as a `<file>` block,
 * the wrapper the TUI uses for text mentions. Error chips are skipped.
 */
export function composeTextAttachments(text: string, files: readonly TextAttachment[]): string {
	const blocks = files.flatMap((file) => {
		if (file.text === undefined) return [];
		// Escape the attribute value so a crafted file name cannot close the tag.
		const path = file.name.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
		return [`<file path="${path}">\n${file.text}\n</file>`];
	});
	if (blocks.length === 0) return text;
	return [text, ...blocks].filter((part) => part.length > 0).join("\n\n");
}

/** Matches one composed `<file>` block with the separator that precedes it. */
const FILE_BLOCK = /(^|\n\n)<file path="([^"]*)">\n([\s\S]*?)\n<\/file>/g;

/**
 * Inverse of composeTextAttachments: lifts each `<file>` block out of a queued
 * message back into a text chip, so an edited message restores its files.
 */
export function splitTextAttachments(message: string): { text: string; files: TextAttachment[] } {
	const files: TextAttachment[] = [];
	const text = message.replace(FILE_BLOCK, (_match, _sep: string, path: string, body: string) => {
		nextId += 1;
		const name = path
			.replace(/&lt;/g, "<")
			.replace(/&quot;/g, '"')
			.replace(/&amp;/g, "&");
		const size = new TextEncoder().encode(body).length;
		const id = `att-${Date.now().toString(36)}-${nextId}`;
		files.push({ id, name, size, text: body });
		return "";
	});
	return { text, files };
}
