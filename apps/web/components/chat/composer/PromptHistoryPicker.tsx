import {
	createEffect,
	createMemo,
	createSignal,
	For,
	on,
	onCleanup,
	onMount,
	Show,
	type Component,
} from "solid-js";
import { fuzzyRank } from "../../../prompt/autocomplete";
import { PromptHistory } from "../../../prompt/history";
import { setPromptInsert } from "../../../state";
import { isImeKey } from "../../../prompt/key-input";
import { searchAutofocus } from "../../../store/integrations";
import type { PresencePhase } from "../../../motion/presence";

/** A picker row: one prompt history string. */
interface PickerEntry {
	text: string;
}

/**
 * Prompt history popover, anchored to the composer's top-left corner and
 * growing up and to the right. PromptBox opens it on Up with the caret on the
 * top row; the composer owns its open state (anchored popover, not a
 * ModalHost overlay). The newest (or best-matching) entry sits at the bottom,
 * next to the prompt: Up walks older, Down past the newest returns to the
 * prompt. Typing fuzzy-filters; Enter/click inserts the entry through the
 * promptInsert inbox; Esc or focus leaving the popover closes it.
 */

export const PromptHistoryPicker: Component<{
	/** `restoreFocus`: hand focus back to the prompt (false when focus moved elsewhere). */
	onClose: (restoreFocus: boolean) => void;
	/** Motion phase from the host's presence (`data-motion`); an exiting popover is inert. Omitted: static, no motion. */
	phase?: PresencePhase;
	/** Host presence ref: lets the presence observe the exit transition's end. */
	ref?: (el: HTMLElement) => void;
}> = (props) => {
	const [query, setQuery] = createSignal("");
	const [selected, setSelected] = createSignal(0);
	// Fresh read per open so entries pushed this session (or in another tab)
	// are included; PromptHistory persists every push to localStorage.
	const entries: PickerEntry[] = new PromptHistory().list().map((text) => ({ text }));
	const listId = `prompt-history-${Math.random().toString(36).slice(2, 8)}`;
	let root!: HTMLDivElement;
	let input!: HTMLInputElement;
	let listEl: HTMLDivElement | undefined;
	// Index the pointer last selected: only keyboard moves scroll into view.
	let pointerPick = -1;

	const filtered = createMemo(() =>
		entries
			.map((entry, index) => ({ ...entry, index, rank: fuzzyRank(query(), entry.text) }))
			.filter((x): x is PickerEntry & { index: number; rank: number } => x.rank !== null)
			.sort((a, b) => a.rank - b.rank || a.index - b.index),
	);

	createEffect(() => {
		query();
		setSelected(0);
	});
	createEffect(() => {
		void filtered();
		const sel = selected();
		if (sel !== pointerPick) listEl?.children[sel]?.scrollIntoView({ block: "nearest" });
		pointerPick = -1;
	});

	const choose = (item: PickerEntry) => {
		setPromptInsert({ text: item.text });
		props.onClose(true);
	};

	const onKeyDown = (e: KeyboardEvent) => {
		if (isImeKey(e)) return;
		const list = filtered();
		if (e.key === "ArrowUp") {
			e.preventDefault();
			setSelected((i) => Math.min(i + 1, list.length - 1));
			return;
		}
		if (e.key === "ArrowDown") {
			e.preventDefault();
			if (selected() === 0) props.onClose(true);
			else setSelected((i) => i - 1);
			return;
		}
		if (e.key === "Enter") {
			e.preventDefault();
			const item = list[selected()];
			if (item) choose(item);
			return;
		}
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			props.onClose(true);
		}
	};

	// Focus on mount and again when a reopen reverses an exit in place (presence
	// keeps the popover mounted, so focus is still in the textarea). A touch screen
	// keeps focus in the composer: a keyboard raised here would cover the list.
	createEffect(
		on(
			() => props.phase,
			(phase) => phase !== "exit" && searchAutofocus() && input.focus(),
		),
	);

	// With focus left in the composer (touch) no focusout ever fires, so a tap outside closes
	// the popover. The composer's history button toggles it, so it is not "outside".
	onMount(() => {
		const onOutside = (e: PointerEvent) => {
			const target = e.target as Element | null;
			if (!target || root.contains(target) || target.closest("[data-history-toggle]")) return;
			props.onClose(false);
		};
		document.addEventListener("pointerdown", onOutside, true);
		onCleanup(() => document.removeEventListener("pointerdown", onOutside, true));
	});

	return (
		<div
			ref={(el) => {
				root = el;
				props.ref?.(el);
			}}
			class="history-popover"
			data-motion={props.phase}
			inert={props.phase === "exit"}
			role="dialog"
			aria-label="Prompt history"
			onFocusOut={(e) => {
				if (!root.contains(e.relatedTarget as Node | null)) props.onClose(false);
			}}
		>
			<div class="history-popover-list" role="listbox" id={listId} ref={listEl}>
				<For each={filtered()}>
					{(item, i) => (
						<div
							class="history-popover-row"
							classList={{ selected: i() === selected() }}
							id={`${listId}-opt-${i()}`}
							role="option"
							aria-selected={i() === selected()}
							title={item.text}
							// mousemove, not mouseenter: wheel-scrolling rows under a still
							// pointer must not steal the keyboard selection.
							onMouseMove={() => {
								if (i() === selected()) return;
								pointerPick = i();
								setSelected(i());
							}}
							onMouseDown={(e) => e.preventDefault() /* keep the search input focused */}
							onClick={() => choose(item)}
						>
							{item.text}
						</div>
					)}
				</For>
				<Show when={filtered().length === 0}>
					<div class="history-popover-empty">
						{entries.length === 0 ? "No prompt history yet" : "No matching prompts"}
					</div>
				</Show>
			</div>
			<input
				ref={input}
				class="history-popover-input"
				role="combobox"
				aria-label="Search prompt history"
				aria-expanded="true"
				aria-controls={listId}
				aria-activedescendant={filtered().length > 0 ? `${listId}-opt-${selected()}` : undefined}
				placeholder="Search prompt history…"
				autocomplete="off"
				autocapitalize="off"
				spellcheck={false}
				enterkeyhint="search"
				value={query()}
				onInput={(e) => setQuery(e.currentTarget.value)}
				onKeyDown={onKeyDown}
			/>
		</div>
	);
};
