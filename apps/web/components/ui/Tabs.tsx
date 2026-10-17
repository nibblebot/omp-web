import { For, type JSX } from "solid-js";
import { moveRovingFocus } from "./roving";

/** One tab of a `Tabs` strip. */
export interface TabItem<T extends string> {
	id: T;
	label: string;
}

/** DOM id of the tab button for `id`; pair with `tabPanelId` on the panel's `aria-labelledby`. */
export const tabButtonId = (idPrefix: string, id: string): string => `${idPrefix}-tab-${id}`;

/** DOM id for the panel of tab `id`; set it on the `role="tabpanel"` element. */
export const tabPanelId = (idPrefix: string, id: string): string => `${idPrefix}-panel-${id}`;

/**
 * Horizontal tab strip (WAI-ARIA tablist, roving tabindex: one tab stop,
 * arrows/Home/End move and select). Controlled: the caller owns `value` and
 * renders the active panel itself with `role="tabpanel"`, `id={tabPanelId(...)}`
 * and `aria-labelledby={tabButtonId(...)}`.
 */
export function Tabs<T extends string>(props: {
	tabs: readonly TabItem<T>[];
	value: T;
	onChange: (id: T) => void;
	/** Accessible name of the tablist. */
	label: string;
	/** Prefix that keeps tab/panel ids unique when several tab strips are mounted. */
	idPrefix: string;
}): JSX.Element {
	return (
		<div
			class="ui-tabs"
			role="tablist"
			aria-label={props.label}
			onKeyDown={(e) => {
				const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
				const target = moveRovingFocus(
					e,
					buttons,
					buttons.indexOf(e.target as HTMLElement),
					"horizontal",
					true,
				);
				if (target !== null) buttons[target].click();
			}}
		>
			<For each={props.tabs}>
				{(tab) => (
					<button
						type="button"
						role="tab"
						class="ui-tab"
						id={tabButtonId(props.idPrefix, tab.id)}
						aria-selected={props.value === tab.id}
						aria-controls={tabPanelId(props.idPrefix, tab.id)}
						tabIndex={props.value === tab.id ? 0 : -1}
						onClick={() => props.onChange(tab.id)}
					>
						{tab.label}
					</button>
				)}
			</For>
		</div>
	);
}
