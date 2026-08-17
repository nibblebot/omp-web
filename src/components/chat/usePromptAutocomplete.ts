import { createEffect, createMemo, createSignal, type Accessor, type Setter } from "solid-js";
import { currentToken, fuzzyRank, type AcToken } from "../../autocomplete";
import { LOCAL_COMMANDS } from "../../commands";
import { listFiles, state } from "../../state";
import type { AcItem } from "./Autocomplete";

const LOCAL_DETAILS: Record<string, string> = {
	new: "Start a new session",
	clear: "Start a new session",
	resume: "Resume a previous session",
	tree: "Branch from an earlier message",
	branch: "Branch from an earlier message",
	export: "Export session as HTML",
	retry: "Retry the last failed turn",
	fork: "Fork this session's history",
	fresh: "Reset provider state, keep transcript",
	handoff: "Hand off to a new session with a summary document",
	drop: "Discard this session and start fresh",
	dump: "Download transcript and LLM request dump",
	rename: "Rename this session (bare: agent auto-titles)",
	compact: "Compact session context",
	queue: "Queue a follow-up message",
	help: "Keyboard shortcuts",
	hotkeys: "Keyboard shortcuts",
	exit: "Close this tab",
	quit: "Close this tab",
};

export interface PromptAutocomplete {
	token: Accessor<AcToken | null>;
	setToken: Setter<AcToken | null>;
	dismissed: Accessor<boolean>;
	setDismissed: Setter<boolean>;
	selected: Accessor<number>;
	setSelected: Setter<number>;
	refreshToken: () => void;
	items: () => AcItem[];
	open: () => boolean;
	apply: (item: AcItem) => void;
	autoGrow: () => void;
}

/**
 * Autocomplete state for the prompt composer: the `/…` and `@…` token under
 * the caret, popup selection/dismissal, the debounced server-side file walk,
 * and the ranked completion list. PromptBox owns the keyboard state machine
 * and drives everything here; the composer wires it to the textarea events.
 */
export function usePromptAutocomplete(
	getTextarea: () => HTMLTextAreaElement | undefined,
	message: () => string,
	setMessage: Setter<string>,
): PromptAutocomplete {
	const [token, setToken] = createSignal<AcToken | null>(null);
	const [dismissed, setDismissed] = createSignal(false);
	const [selected, setSelected] = createSignal(0);
	const [files, setFiles] = createSignal<string[]>([]);
	let debounceTimer: number | undefined;

	const autoGrow = () => {
		const ta = getTextarea();
		if (!ta) return;
		ta.style.height = "auto";
		ta.style.height = `${ta.scrollHeight}px`;
	};

	const refreshToken = () => {
		if (dismissed()) return;
		const ta = getTextarea();
		setToken(currentToken(message(), ta?.selectionStart ?? message().length));
	};

	// @-file completions: debounced server-side walk, latest-wins.
	createEffect(() => {
		const t = token();
		if (t?.mode !== "file") return;
		window.clearTimeout(debounceTimer);
		debounceTimer = window.setTimeout(() => {
			listFiles(t.query)
				.then(setFiles)
				.catch(() => setFiles([]));
		}, 150);
	});

	// Ranked completion list, memoized on its real inputs (completion token /
	// query signal, file results, and the remote command list) so the
	// fuzzyRank pass over every command runs once per change, not 2-3x per
	// keystroke. Recomputes only when the token (query), files(), or
	// state.availableCommands change; navigation/selection handlers read the
	// same memoized array and never mutate it.
	const rankedItems = createMemo<AcItem[]>(() => {
		const t = token();
		if (!t) return [];
		if (t.mode === "file") {
			return files().map((f) => ({
				label: `@${f}`,
				apply: f.includes(" ") ? `@"${f}" ` : `@${f} `,
			}));
		}
		const local = Object.keys(LOCAL_COMMANDS).map((name) => ({
			name,
			detail: LOCAL_DETAILS[name] ?? "web-local",
		}));
		const remote = state.availableCommands
			.filter((c) => !LOCAL_COMMANDS[c.name])
			.map((c) => ({ name: c.name, detail: c.description ?? c.input?.hint ?? "" }));
		return [...local, ...remote]
			.map((c) => ({ c, rank: fuzzyRank(t.query, c.name) }))
			.filter((x): x is { c: { name: string; detail: string }; rank: number } => x.rank !== null)
			.sort((a, b) => a.rank - b.rank)
			.map((x) => ({ label: `/${x.c.name}`, detail: x.c.detail, apply: `/${x.c.name} ` }));
	});

	const items = (): AcItem[] => rankedItems();

	const open = () => token() !== null && items().length > 0;

	const apply = (item: AcItem) => {
		const t = token();
		if (!t) return;
		setMessage(message().slice(0, t.start) + item.apply + message().slice(t.end));
		setToken(null);
		const ta = getTextarea();
		requestAnimationFrame(() => {
			ta?.focus();
			if (ta) {
				const pos = t.start + item.apply.length;
				ta.setSelectionRange(pos, pos);
			}
			autoGrow();
		});
	};

	return {
		token,
		setToken,
		dismissed,
		setDismissed,
		selected,
		setSelected,
		refreshToken,
		items,
		open,
		apply,
		autoGrow,
	};
}
