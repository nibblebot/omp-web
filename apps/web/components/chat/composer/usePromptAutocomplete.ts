import { createEffect, createMemo, createSignal, type Accessor, type Setter } from "solid-js";
import {
	currentToken,
	fenceOpen,
	fuzzyRank,
	sameToken,
	type AcToken,
} from "../../../prompt/autocomplete";
import { commandUsage, currentCommandRegistry } from "../../../prompt/commands";
import {
	emojiInlineReplace,
	emojiSuggestions,
	ensureEmojiTable,
	extractTrigger as extractEmojiTrigger,
} from "../../../prompt/emoji";
import { listFiles, state } from "../../../state";
import { settingValue } from "../../../store/settings";
import { commandLiveState, rankCommands } from "../../../prompt/command-registry";
import type { AcItem } from "./AutocompletePopup";

/** SDK default for `autocompleteMaxVisible`; the TUI editor clamps to 3..20. */
const MAX_VISIBLE_DEFAULT = 10;

/** Popup row cap from the `autocompleteMaxVisible` setting, clamped like the TUI editor. */
export function clampMaxVisible(value: number | undefined): number {
	const n =
		typeof value === "number" && Number.isFinite(value) ? Math.round(value) : MAX_VISIBLE_DEFAULT;
	return Math.min(20, Math.max(3, n));
}

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
	/** Popup row cap (`autocompleteMaxVisible`, clamped 3..20). */
	maxVisible: () => number;
	/** Rewrites a just-typed `:name:` shortcode or emoticon in the textarea; true when it did. */
	inlineEmoji: () => boolean;
}

/**
 * AutocompletePopup state for the prompt composer: the `/…`, `@…`, and `:…`
 * (emoji) token under the caret, popup selection/dismissal, the debounced
 * server-side file walk, and the ranked completion list. PromptBox owns the
 * keyboard state machine and drives everything here; the composer wires it to
 * the textarea events.
 */
export function usePromptAutocomplete(
	getTextarea: () => HTMLTextAreaElement | undefined,
	message: () => string,
	setMessage: Setter<string>,
): PromptAutocomplete {
	const [token, setToken] = createSignal<AcToken | null>(null, { equals: sameToken });
	const [dismissed, setDismissed] = createSignal(false);
	const [selected, setSelected] = createSignal(0);
	const [files, setFiles] = createSignal<string[]>([]);
	const [emojiReady, setEmojiReady] = createSignal(false);
	let debounceTimer: number | undefined;

	// settingValue is reactive: memoized lists and handlers follow live changes.
	const emojiOn = () => settingValue<boolean>("emojiAutocomplete") !== false;
	const maxVisible = () => clampMaxVisible(settingValue<number>("autocompleteMaxVisible"));

	const autoGrow = () => {
		const ta = getTextarea();
		if (!ta) return;
		ta.style.height = "auto";
		ta.style.height = `${ta.scrollHeight}px`;
	};

	/** `:name` token ending at the caret; null outside the setting, inside a code fence, or with no trigger. */
	const emojiToken = (text: string, caret: number): AcToken | null => {
		if (!emojiOn()) return null;
		const before = text.slice(0, caret);
		if (fenceOpen(before)) return null;
		const trig = extractEmojiTrigger(before);
		if (!trig) return null;
		void ensureEmojiTable().then(() => setEmojiReady(true));
		return { mode: "emoji", query: trig.query, start: caret - trig.prefix.length, end: caret };
	};

	const refreshToken = () => {
		if (dismissed()) return;
		const ta = getTextarea();
		const text = message();
		const caret = ta?.selectionStart ?? text.length;
		setToken(currentToken(text, caret) ?? emojiToken(text, caret));
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
	// query signal, file results, emoji table readiness, and the remote command
	// list) so the fuzzyRank pass over every command runs once per change, not
	// 2-3x per keystroke. Navigation/selection handlers read the same memoized
	// array and never mutate it.
	const rankedItems = createMemo<AcItem[]>(() => {
		const t = token();
		if (!t) return [];
		if (t.mode === "emoji") {
			if (!emojiReady()) return [];
			const found = emojiSuggestions(message().slice(0, t.end));
			return found ? found.items.map((e) => ({ label: e.label, apply: e.emoji })) : [];
		}
		if (t.mode === "file") {
			return files().map((f) => ({
				label: `@${f}`,
				apply: f.includes(" ") ? `@"${f}" ` : `@${f} `,
			}));
		}
		return rankCommands(currentCommandRegistry(), t.query, commandUsage(), fuzzyRank).map(
			({ entry }) => ({
				label: `/${entry.name}`,
				detail: entry.description,
				hint: entry.hint,
				live: commandLiveState(entry.name, state),
				apply: `/${entry.name} `,
			}),
		);
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

	const inlineEmoji = (): boolean => {
		if (!emojiOn()) return false;
		const ta = getTextarea();
		if (!ta) return false;
		const caret = ta.selectionStart;
		const before = ta.value.slice(0, caret);
		// Shortcodes need the table; load it on a closing colon, not every keystroke.
		if (before.endsWith(":")) void ensureEmojiTable().then(() => setEmojiReady(true));
		const r = emojiInlineReplace(before);
		if (!r) return false;
		const start = caret - r.replaceLen;
		const next = ta.value.slice(0, start) + r.insert + ta.value.slice(caret);
		const pos = start + r.insert.length;
		ta.value = next;
		ta.setSelectionRange(pos, pos);
		setMessage(next);
		return true;
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
		maxVisible,
		inlineEmoji,
	};
}
