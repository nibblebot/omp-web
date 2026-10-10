import { For, Show, type JSX } from "solid-js";
import { Card } from "./Card";
import { useClickableRow } from "./PickerRow";

interface BackgroundBarProps<T> {
	/** Rows to list; the bar renders nothing while this is empty. Rows are keyed by item
	    identity, so callers may pass stable ids and resolve live objects inside `children`. */
	items: T[];
	/** Accessible name for the group of rows. */
	label: string;
	/** Makes each row a keyboard-activatable button (role, tabindex, Enter/Space). */
	onRowClick?: (item: T) => void;
	/** Row content for one item. */
	children: (item: T) => JSX.Element;
}

/** Strip listing work running in the background; domain-free. Hidden while `items` is empty. */
export function BackgroundBar<T>(props: BackgroundBarProps<T>): JSX.Element {
	const row = (item: T): JSX.Element => {
		const onRowClick = props.onRowClick;
		if (!onRowClick) {
			return <div class="background-bar-row">{props.children(item)}</div>;
		}
		return (
			<div
				class="background-bar-row background-bar-row--clickable"
				{...useClickableRow(() => onRowClick(item))}
			>
				{props.children(item)}
			</div>
		);
	};
	return (
		<Show when={props.items.length > 0}>
			<Card class="background-bar">
				<div class="background-bar-rows" role="group" aria-label={props.label}>
					<For each={props.items}>{(item) => row(item)}</For>
				</div>
			</Card>
		</Show>
	);
}
