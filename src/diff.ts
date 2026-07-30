import { diffLines } from "diff";

export type DiffRow = { type: "add" | "del" | "context"; text: string } | { type: "collapse"; count: number };

/** Split diff parts into typed lines, dropping the trailing-newline artifact. */
function toLines(oldText: string, newText: string): Array<{ type: "add" | "del" | "context"; text: string }> {
	const lines: Array<{ type: "add" | "del" | "context"; text: string }> = [];
	for (const part of diffLines(oldText, newText)) {
		const type = part.added ? "add" : part.removed ? "del" : "context";
		const split = part.value.split("\n");
		if (split[split.length - 1] === "") split.pop();
		for (const text of split) lines.push({ type, text });
	}
	return lines;
}

/**
 * Inline line diff with context collapsing: runs of unchanged lines are kept
 * to `context` lines on each side of a change, the middle becomes a collapse
 * marker. A run touching both ends (unchanged input) is never collapsed.
 */
export function buildDiffRows(oldText: string, newText: string, context = 3): DiffRow[] {
	const lines = toLines(oldText, newText);
	const rows: DiffRow[] = [];
	let i = 0;
	while (i < lines.length) {
		if (lines[i].type !== "context") {
			rows.push(lines[i]);
			i++;
			continue;
		}
		let j = i;
		while (j < lines.length && lines[j].type === "context") j++;
		const run = lines.slice(i, j);
		const keepHead = i === 0 ? (j === lines.length ? run.length : context) : context;
		const keepTail = j === lines.length ? context : context;
		if (run.length <= keepHead + keepTail + 1) {
			rows.push(...run);
		} else {
			rows.push(...run.slice(0, keepHead));
			rows.push({ type: "collapse", count: run.length - keepHead - keepTail });
			rows.push(...run.slice(run.length - keepTail));
		}
		i = j;
	}
	return rows;
}
