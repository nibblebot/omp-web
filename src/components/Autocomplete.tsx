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
}> = props => (
	<div class="autocomplete" role="listbox">
		<For each={props.items.slice(0, 12)}>
			{(item, i) => (
				<div
					class="autocomplete-row"
					classList={{ selected: i() === props.selected }}
					role="option"
					aria-selected={i() === props.selected}
					onMouseEnter={() => props.onHover(i())}
					onMouseDown={e => {
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
