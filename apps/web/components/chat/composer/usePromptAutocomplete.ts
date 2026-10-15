import { createEffect, createMemo, createSignal, type Accessor, type Setter } from "solid-js";
import { currentToken, fenceOpen, fuzzyRank, type AcToken } from "../../../prompt/autocomplete";
import { LOCAL_COMMANDS } from "../../../prompt/commands";
import {
	emojiInlineReplace,
	emojiSuggestions,
	ensureEmojiTable,
	extractTrigger as extractEmojiTrigger,
} from "../../../prompt/emoji";
import { listFiles, state } from "../../../state";
import { settingValue } from "../../../store/settings";
import { featureCommandDetails } from "../../../features/registry";
import { featureForCommand } from "../../../features/manifest";
import type { AcItem } from "./AutocompletePopup";

const LOCAL_DETAILS: Record<string, string> = {
	new: "Start a new session",
	clear: "Clear context in place, keep session",
	resume: "Resume a previous session (or /resume <id> to switch directly)",
	tree: "Branch from an earlier message",
	branch: "Branch from an earlier message",
	export: "Export session as HTML (/export [--themes] [path])",
	retry: "Retry the last failed turn",
	fork: "Fork this session's history",
	fresh: "Reset provider state, keep transcript",
	handoff: "Hand off: compact in place with a summary document",
	delete: "Delete this session permanently",
	dump: "Download transcript (/dump [all])",
	rename: "Rename this session (bare: agent auto-titles)",
	compact: "Compact session context (/compact [soft|remote|snapcompact] [focus])",
	model: "Model picker (or /model provider/id)",
	live: "Unavailable in the browser",
	move: "Unavailable for attached sessions",
	wt: "Unavailable for attached sessions",
	worktree: "Unavailable for attached sessions",
	queue: "Queue a follow-up message",
	plan: "Toggle plan mode (/plan [prompt])",
	compaction: "Context compaction controls",
	help: "Keyboard shortcuts",
	hotkeys: "Keyboard shortcuts",
	exit: "Close this tab",
	quit: "Close this tab",
};

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
	/** Rewrites a just-typed `:name:` shortcode or emoticon in the textarea. */
	inlineEmoji: () => void;
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
	const [token, setToken] = createSignal<AcToken | null>(null);
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
		const local = [
			...Object.keys(LOCAL_COMMANDS).map((name) => ({
				name,
				detail: LOCAL_DETAILS[name] ?? "web-local",
			})),
			...featureCommandDetails().map(([name, detail]) => ({ name, detail })),
		];
		const remote = state.availableCommands
			.filter((c) => !LOCAL_COMMANDS[c.name] && !featureForCommand(c.name))
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

	const inlineEmoji = (): void => {
		if (!emojiOn()) return;
		const ta = getTextarea();
		if (!ta) return;
		const caret = ta.selectionStart;
		const before = ta.value.slice(0, caret);
		// Shortcodes need the table; load it on a closing colon, not every keystroke.
		if (before.endsWith(":")) void ensureEmojiTable().then(() => setEmojiReady(true));
		const r = emojiInlineReplace(before);
		if (!r) return;
		const start = caret - r.replaceLen;
		const next = ta.value.slice(0, start) + r.insert + ta.value.slice(caret);
		const pos = start + r.insert.length;
		ta.value = next;
		ta.setSelectionRange(pos, pos);
		setMessage(next);
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
