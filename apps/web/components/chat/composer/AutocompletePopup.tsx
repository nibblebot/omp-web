import { createEffect, For, type Component } from "solid-js";

export interface AcItem {
	label: string;
	detail?: string;
	/** Argument hint shown after the label, e.g. `[soft|remote] [focus]`. */
	hint?: string;
	/** Current value of a setting-like command (model id, plan on/off), shown at the row end. */
	live?: string;
	apply: string;
}

/** Popup list above the textarea; PromptBox owns selection state and keys. */
export const AutocompletePopup: Component<{
	items: AcItem[];
	selected: number;
	/** Rows visible before the list scrolls (`autocompleteMaxVisible`). */
	maxVisible: number;
	onHover: (index: number) => void;
	onApply: (item: AcItem) => void;
	listId: string;
}> = (props) => {
	let listEl: HTMLDivElement | undefined;
	// Index the pointer last selected: pointer selection targets a row the user
	// can already see, so only keyboard moves scroll the selection into view.
	let pointerPick = -1;
	createEffect(() => {
		void props.items; // re-filtering resets the selection: reveal it too
		const sel = props.selected;
		if (sel !== pointerPick) listEl?.children[sel]?.scrollIntoView({ block: "nearest" });
		pointerPick = -1;
	});
	// Row height is measured from the first row so the row cap follows the font and
	// padding. It is only a custom property: `.autocomplete` (prompt.css) clamps it to the
	// viewport, so ten 44px touch rows never push the best matches above the screen.
	createEffect(() => {
		void props.items;
		void props.maxVisible;
		const row = listEl?.children[0] as HTMLElement | undefined;
		if (!listEl || !row) return;
		// +2: the 1px top and bottom borders.
		listEl.style.setProperty("--ac-rows-h", `${row.offsetHeight * props.maxVisible + 2}px`);
	});
	return (
		<div class="autocomplete" role="listbox" id={props.listId} ref={listEl}>
			<For each={props.items}>
				{(item, i) => (
					<div
						class="autocomplete-row"
						classList={{ selected: i() === props.selected }}
						id={`${props.listId}-opt-${i()}`}
						role="option"
						aria-selected={i() === props.selected}
						// mousemove, not mouseenter: wheel-scrolling rows under a still
						// pointer must not steal the keyboard selection.
						onMouseMove={() => {
							if (i() === props.selected) return;
							pointerPick = i();
							props.onHover(i());
						}}
						onMouseDown={(e) => {
							e.preventDefault(); // keep textarea focus
							props.onApply(item);
						}}
					>
						<span class="autocomplete-label">{item.label}</span>
						{item.hint && <span class="autocomplete-hint">{item.hint}</span>}
						{item.detail && <span class="autocomplete-detail">{item.detail}</span>}
						{item.live && <span class="autocomplete-live">{item.live}</span>}
					</div>
				)}
			</For>
		</div>
	);
};
