import { createEffect, For, type Component } from "solid-js";

export interface AcItem {
	label: string;
	detail?: string;
	apply: string;
}

/** Popup list above the textarea; PromptBox owns selection state and keys. */
export const Autocomplete: Component<{
	items: AcItem[];
	selected: number;
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
						{item.detail && <span class="autocomplete-detail">{item.detail}</span>}
					</div>
				)}
			</For>
		</div>
	);
};
