/**
 * Thinking-block display text. Port of the TUI's `formatThinkingForDisplay`
 * and `hasDisplayableThinking` (pi-tui chat/thinking-display.ts), stateless:
 * callers memoize per block. Both modes drop empty `<!-- -->` sentinel lines
 * outside code fences (gpt-5.x summary padding); prose-only mode also elides
 * fenced code down to a trailing ellipsis on the preceding prose line.
 */

const FENCE_RE = /^( {0,3})([`~]{3,})/;
const EMPTY_COMMENT_RE = /^<!--\s*-->$/;
const OPEN_COMMENT_RE = /^<!--\s*$/;

/** Whether `line` is reasoning-summary comment noise (empty comment, or a still-open `<!--` on the last line). */
function isCommentNoise(line: string, isLastLine: boolean): boolean {
	const trimmed = line.trim();
	return EMPTY_COMMENT_RE.test(trimmed) || (isLastLine && OPEN_COMMENT_RE.test(trimmed));
}

/** Rewrite `lines`' last non-blank line to end in an ellipsis (a lone "..." when there is none). */
function appendEllipsis(lines: string[]): void {
	for (let i = lines.length - 1; i >= 0; i--) {
		const trimmed = lines[i]!.trimEnd();
		if (trimmed === "") continue;
		if (trimmed.endsWith("...")) lines[i] = trimmed;
		else if (trimmed.endsWith(".")) lines[i] = `${trimmed.slice(0, -1)}...`;
		else lines[i] = `${trimmed}...`;
		return;
	}
	lines.push("...");
}

export function formatThinkingForDisplay(text: string, proseOnly: boolean): string {
	if (!text) return text;
	const hasComment = text.includes("<!--");
	if (!proseOnly && !hasComment) return text;
	const input = text.split("\n");
	const last = input.length - 1;
	const out: string[] = [];
	let inFence = false;
	let fenceChar = "";
	let fenceLen = 0;
	for (let i = 0; i < input.length; i++) {
		const line = input[i]!;
		if (inFence) {
			const close = FENCE_RE.exec(line);
			if (
				close &&
				close[2]![0] === fenceChar &&
				close[2]!.length >= fenceLen &&
				line.slice(close[1]!.length + close[2]!.length).trim() === ""
			) {
				inFence = false;
			}
			if (!proseOnly) out.push(line);
			continue;
		}
		if (hasComment && isCommentNoise(line, i === last)) continue;
		const open = FENCE_RE.exec(line);
		if (open) {
			const marker = open[2]!;
			// A backtick fence's info string may not contain a backtick.
			if (!(marker[0] === "`" && line.slice(open[1]!.length + marker.length).includes("`"))) {
				inFence = true;
				fenceChar = marker[0]!;
				fenceLen = marker.length;
				if (proseOnly) appendEllipsis(out);
				else out.push(line);
				continue;
			}
		}
		out.push(line);
	}
	return out.join("\n");
}

/** Raw text that is empty or only dots/ellipses/whitespace (a placeholder, not content). */
function isPlaceholder(text: string): boolean {
	return /^[.…\s]*$/.test(text);
}

/** Whether a thinking block has content worth rendering once formatted. */
export function hasDisplayableThinking(text: string, formatted: string): boolean {
	return formatted.trim().length > 0 && !isPlaceholder(text);
}
