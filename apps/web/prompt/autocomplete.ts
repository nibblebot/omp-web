/**
 * Pure autocomplete logic: token extraction under the caret, fenced-code
 * suppression, and fuzzy ranking (exact > startsWith > subsequence).
 */

/** `emoji` is the `:name` shortcode token (emoji.ts), completed outside `/`, `@` and `^` tokens. `model` is a `^provider/model[:effort]` subagent tag (model-mention.ts). */
export type AcToken = {
	mode: "slash" | "file" | "emoji" | "model";
	query: string;
	start: number;
	end: number;
};

/** Whether two completion tokens are the same span and query, so a repeated caret read changes nothing. */
export function sameToken(a: AcToken | null, b: AcToken | null): boolean {
	if (a === null || b === null) return a === b;
	return a.mode === b.mode && a.query === b.query && a.start === b.start && a.end === b.end;
}

/** Odd count of ``` fences before the caret = inside a code block. */
export function fenceOpen(text: string): boolean {
	return (text.match(/^```/gm)?.length ?? 0) % 2 === 1;
}

/**
 * The completable token at the caret: `/…` only at position 0 (slash
 * commands), `@…` and `^…` after start/whitespace (file and model
 * mentions). Null when the caret is mid-word on an ordinary token or inside
 * a fenced code block.
 */
export function currentToken(text: string, caret: number): AcToken | null {
	const before = text.slice(0, caret);
	if (fenceOpen(before)) return null;
	const m = /(?:^|\s)([/@^]\S*)$/.exec(before);
	if (!m) return null;
	const token = m[1];
	const start = caret - token.length;
	if (token.startsWith("/")) {
		if (start !== 0) return null;
		return { mode: "slash", query: token.slice(1), start, end: caret };
	}
	if (token.startsWith("^")) return { mode: "model", query: token.slice(1), start, end: caret };
	return { mode: "file", query: token.slice(1), start, end: caret };
}

/**
 * Lower is better; null = no match. Subsequence matches rank by the spread
 * between first and last matched character.
 */
export function fuzzyRank(query: string, candidate: string): number | null {
	const q = query.toLowerCase();
	const c = candidate.toLowerCase();
	if (q === "") return 0;
	if (c === q) return 0;
	if (c.startsWith(q)) return 1 + (c.length - q.length) / 100;
	let qi = 0;
	let first = -1;
	let last = -1;
	for (let i = 0; i < c.length && qi < q.length; i++) {
		if (c[i] === q[qi]) {
			if (first < 0) first = i;
			last = i;
			qi++;
		}
	}
	if (qi < q.length) return null;
	return 2 + (last - first) / 100;
}
