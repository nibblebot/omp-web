import { For, type Component } from "solid-js";

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
}> = (props) => (
	<div class="autocomplete" role="listbox" id={props.listId}>
		<For each={props.items.slice(0, Math.max(12, props.selected + 1))}>
			{(item, i) => (
				<div
					class="autocomplete-row"
					classList={{ selected: i() === props.selected }}
					id={`${props.listId}-opt-${i()}`}
					role="option"
					aria-selected={i() === props.selected}
					onMouseEnter={() => props.onHover(i())}
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
