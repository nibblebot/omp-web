/**
 * P2 bounded Vim subset (G03). Optional, documented, accessible: the plain
 * textarea is always available (toggle off = exact current behavior + IME
 * intact). When enabled:
 *
 * - insert: ordinary typing (IME composed text passes through untouched).
 * - normal: h/l (or arrows) move, 0/$ line ends, w/b word jumps,
 *   j/k line jumps, x delete-char, d+d delete-line, u undo, i/a insert,
 *   v visual, :w no-op confirm (no file writes from the composer).
 * - visual: h/l/0/$/w/b extend, y yank-to-clipboard, d cut, Esc normal.
 * - Operator `d` + motion; counts (`2w`, `3j`) for motions.
 * - Undo is a bounded (50-step) text buffer, NOT history navigation.
 *
 * Anything else is ignored (no beep, no trap): unclaimed keys fall through
 * to the host handler (autocomplete/queue/Escape semantics preserved).
 * IME composition (`isComposing` or keyCode 229) always bypasses the
 * state machine and forces insert.
 */

export type VimMode = "insert" | "normal" | "visual";

export const VIM_DOC: Array<{ keys: string; what: string }> = [
	{ keys: "i / a", what: "insert (at cursor / after cursor)" },
	{ keys: "v", what: "visual select" },
	{ keys: "Esc", what: "normal mode (visual/normal); plain Esc handling in insert" },
	{ keys: "h l 0 $ w b j k", what: "move (char / line-end / word / line)" },
	{ keys: "x", what: "delete char under cursor" },
	{ keys: "d+d / d+motion", what: "delete line / delete through motion" },
	{ keys: "y (visual)", what: "yank selection to clipboard" },
	{ keys: "u", what: "undo (bounded text buffer)" },
	{ keys: ":w", what: "confirm (no file is written)" },
];

const UNDO_CAP = 50;

export interface VimSnapshot {
	text: string;
	start: number;
	end: number;
}

export class VimState {
	mode: VimMode = "insert";
	enabled = false;
	/** Armed `d` operator awaiting its motion (or second `d`). */
	armedOp: "d" | null = null;
	/** Pending numeric count prefix (`2w`, `3j`). */
	countText = "";
	/** Colon line open (`:w` confirm). */
	inColon = false;
	private selAnchor: number | null = null;
	private undoStack: VimSnapshot[] = [];

	toggle(): VimMode | null {
		this.enabled = !this.enabled;
		if (!this.enabled) {
			this.mode = "insert";
			this.clearPending();
			this.selAnchor = null;
			return null;
		}
		this.mode = "normal";
		return this.mode;
	}

	clearPending(): void {
		this.armedOp = null;
		this.countText = "";
		this.inColon = false;
	}

	pushUndo(s: VimSnapshot): void {
		this.undoStack.push(s);
		if (this.undoStack.length > UNDO_CAP)
			this.undoStack.splice(0, this.undoStack.length - UNDO_CAP);
	}

	popUndo(): VimSnapshot | null {
		return this.undoStack.pop() ?? null;
	}

	get anchor(): number | null {
		return this.selAnchor;
	}

	enterVisual(pos: number): void {
		this.mode = "visual";
		this.selAnchor = pos;
	}

	enterNormal(): void {
		this.mode = "normal";
		this.clearPending();
		this.selAnchor = null;
	}

	enterInsert(): void {
		this.mode = "insert";
		this.clearPending();
		this.selAnchor = null;
	}
}

function lineBounds(text: string, pos: number): { start: number; end: number } {
	const start = text.lastIndexOf("\n", pos - 1) + 1;
	const nl = text.indexOf("\n", pos);
	return { start, end: nl === -1 ? text.length : nl };
}

function nextWord(text: string, pos: number): number {
	const m = /\s*\S/.exec(text.slice(pos + 1));
	return m ? pos + 1 + (m[0].length - 1) : text.length;
}

function prevWord(text: string, pos: number): number {
	const before = text.slice(0, pos).replace(/\s+$/, "");
	const m = /\S+\s*$/.exec(before);
	return m?.index ?? 0;
}

function movePos(text: string, pos: number, key: string, count: number): number {
	switch (key) {
		case "h":
			return Math.max(0, pos - count);
		case "l":
			return Math.min(text.length, pos + count);
		case "0":
			return lineBounds(text, pos).start;
		case "$":
			return lineBounds(text, pos).end;
		case "w": {
			let p = pos;
			for (let i = 0; i < count; i++) p = nextWord(text, p);
			return p;
		}
		case "b": {
			let p = pos;
			for (let i = 0; i < count; i++) p = prevWord(text, p);
			return p;
		}
		case "j": {
			let p = pos;
			for (let i = 0; i < count; i++) {
				const cur = lineBounds(text, p);
				if (cur.end >= text.length) break;
				const col = p - cur.start;
				const next = lineBounds(text, cur.end + 1);
				p = Math.min(next.start + col, next.end);
			}
			return p;
		}
		case "k": {
			let p = pos;
			for (let i = 0; i < count; i++) {
				const cur = lineBounds(text, p);
				if (cur.start === 0) break;
				const col = p - cur.start;
				const prev = lineBounds(text, cur.start - 1);
				p = Math.min(prev.start + col, prev.end);
			}
			return p;
		}
		default:
			return pos;
	}
}

function deleteThrough(
	text: string,
	pos: number,
	key: string,
	count: number,
): { text: string; pos: number } | null {
	if (key === "d") {
		// dd: delete `count` whole lines.
		const lines = text.split("\n");
		const curLine = text.slice(0, pos).split("\n").length - 1;
		lines.splice(curLine, count);
		const next = lines.join("\n");
		const clamped = Math.min(curLine, Math.max(0, lines.length - 1));
		const at = lines.slice(0, clamped).join("\n").length + (clamped > 0 ? 1 : 0);
		return { text: next, pos: Math.min(at, next.length) };
	}
	if (key === "x") {
		if (pos >= text.length) return null;
		return { text: text.slice(0, pos) + text.slice(pos + count), pos };
	}
	if (key === "h" || key === "l" || key === "w" || key === "b" || key === "$" || key === "0") {
		const end = movePos(text, pos, key, count);
		const a = Math.min(pos, end);
		let b = Math.max(pos, end);
		// `dw` eats the trailing gap; others cut exactly.
		if (key === "w" && /\s/.test(text[b] ?? "")) b += 1;
		return { text: text.slice(0, a) + text.slice(b), pos: a };
	}
	return null;
}

function copyText(cut: string): void {
	if (!cut) return;
	try {
		void navigator.clipboard?.writeText(cut);
	} catch {
		// Clipboard needs permission/focus: selection stays, user copies manually.
	}
}

export interface VimHandle {
	handled: boolean;
	notice?: string;
}

function isMotionKey(key: string): boolean {
	return (
		key === "h" ||
		key === "l" ||
		key === "0" ||
		key === "$" ||
		key === "w" ||
		key === "b" ||
		key === "j" ||
		key === "k"
	);
}

/**
 * Handle one keydown for the bounded Vim subset. Reads live textarea
 * geometry (selectionStart/End) and writes text/caret directly so IME and
 * Solid signals stay consistent (the caller syncs signals after).
 * Returns handled=true when the key was consumed.
 */
export function handleVimKey(vim: VimState, ta: HTMLTextAreaElement, e: KeyboardEvent): VimHandle {
	if (!vim.enabled) return { handled: false };
	// IME composition always bypasses and forces insert.
	if (e.isComposing || e.keyCode === 229) {
		if (vim.mode !== "insert") vim.enterInsert();
		return { handled: false };
	}
	if (e.ctrlKey || e.metaKey || e.altKey) return { handled: false };
	const text = ta.value;
	const start = ta.selectionStart ?? text.length;
	const end = ta.selectionEnd ?? start;

	// Colon mini-line: `:w` confirms (no write), Esc cancels.
	if (vim.inColon) {
		if (e.key === "Escape") {
			vim.clearPending();
			return { handled: true };
		}
		if (e.key === "Enter") {
			vim.clearPending();
			return { handled: true, notice: "Draft kept in the composer (nothing written to disk)." };
		}
		// Swallow the `w` (and any other single char) while open.
		if (e.key.length === 1) return { handled: true };
		return { handled: false };
	}
	if (vim.mode === "normal" && e.key === ":") {
		vim.inColon = true;
		return { handled: true };
	}

	if (vim.mode === "insert") return { handled: false };

	if (e.key === "Escape") {
		vim.enterNormal();
		ta.setSelectionRange(start, start);
		return { handled: true };
	}

	if (vim.mode === "visual") {
		const anchor = vim.anchor ?? start;
		const lo = Math.min(anchor, end);
		const hi = Math.max(anchor, end);
		if (e.key === "y") {
			copyText(text.slice(lo, hi));
			vim.enterNormal();
			ta.setSelectionRange(lo, lo);
			return { handled: true };
		}
		if (e.key === "d" || e.key === "x") {
			vim.pushUndo({ text, start, end });
			ta.value = text.slice(0, lo) + text.slice(hi);
			ta.setSelectionRange(lo, lo);
			vim.enterNormal();
			return { handled: true };
		}
		if (e.key === "i" || e.key === "a") {
			vim.enterInsert();
			return { handled: true };
		}
		if (isMotionKey(e.key)) {
			const n = movePos(text, end, e.key, 1);
			ta.setSelectionRange(Math.min(anchor, n), Math.max(anchor, n));
			return { handled: true };
		}
		return { handled: false };
	}

	// Normal mode.
	if (/^[1-9]$/.test(e.key) || (e.key === "0" && vim.countText !== "")) {
		vim.countText += e.key;
		return { handled: true };
	}
	const count = vim.countText ? Math.min(99, Number.parseInt(vim.countText, 10) || 1) : 1;
	vim.countText = "";

	if (e.key === "u") {
		vim.clearPending();
		const prev = vim.popUndo();
		if (prev) {
			ta.value = prev.text;
			ta.setSelectionRange(prev.start, prev.end);
		}
		return { handled: true };
	}
	if (e.key === "i" || e.key === "a") {
		vim.clearPending();
		vim.enterInsert();
		const p = e.key === "a" ? Math.min(text.length, start + 1) : start;
		ta.setSelectionRange(p, p);
		return { handled: true };
	}
	if (e.key === "v") {
		vim.clearPending();
		vim.enterVisual(start);
		return { handled: true };
	}
	if (e.key === "x") {
		vim.pushUndo({ text, start, end });
		copyText(text.slice(start, Math.min(text.length, start + count)));
		ta.value = text.slice(0, start) + text.slice(start + count);
		ta.setSelectionRange(start, start);
		vim.clearPending();
		return { handled: true };
	}
	if (e.key === "d") {
		if (vim.armedOp === "d") {
			vim.armedOp = null;
			vim.pushUndo({ text, start, end });
			const r = deleteThrough(text, start, "d", count);
			if (r) {
				ta.value = r.text;
				ta.setSelectionRange(r.pos, r.pos);
			}
			return { handled: true };
		}
		vim.armedOp = "d";
		return { handled: true };
	}
	if (isMotionKey(e.key)) {
		if (vim.armedOp === "d") {
			vim.armedOp = null;
			vim.pushUndo({ text, start, end });
			const r = deleteThrough(text, start, e.key, count);
			if (r) {
				ta.value = r.text;
				ta.setSelectionRange(r.pos, r.pos);
			}
		} else {
			const n = movePos(text, start, e.key, count);
			ta.setSelectionRange(n, n);
		}
		return { handled: true };
	}
	return { handled: false };
}
