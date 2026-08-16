import type { Component, JSX } from "solid-js";

/**
 * Shared picker row: a real <button type="button"> so every picker row is
 * Tab-reachable and Enter/Space-activatable (the AskDialog precedent from
 * #32, generalized to the remaining pickers). The button-chrome reset that
 * makes these render exactly like the legacy div rows lives in styles.css
 * under `button.picker-row`.
 */
export const PickerRow: Component<PickerRowProps> = props => (
	<button
		type="button"
		class={props.class}
		classList={props.classList}
		onClick={props.onClick}
		onMouseEnter={props.onMouseEnter}
		disabled={props.disabled}
		title={props.title}
		aria-pressed={props["aria-pressed"]}
		aria-selected={props["aria-selected"]}
		aria-disabled={props["aria-disabled"]}
	>
		{props.children}
	</button>
);

interface PickerRowProps {
	class?: string;
	classList?: Record<string, boolean | undefined>;
	onClick?: () => void;
	onMouseEnter?: () => void;
	disabled?: boolean;
	title?: string;
	"aria-pressed"?: boolean;
	"aria-selected"?: boolean;
	"aria-disabled"?: boolean;
	children?: JSX.Element;
}

export interface ClickableRowProps {
	role: "button" | undefined;
	tabindex: 0 | -1;
	onClick: (() => void) | undefined;
	onKeyDown: (e: KeyboardEvent) => void;
}

/**
 * Keyboard contract for composite clickable rows that cannot be real
 * <button>s because they contain nested interactive children (subagent
 * steer/abort controls, daemon stop/remove/detail icons): role="button" +
 * tabindex + Enter/Space activation, matching the ActiveSubagents pattern.
 * Spread the result onto the row div. Events that originate on a nested
 * control are left untouched so child buttons keep their own Space/Enter
 * semantics. `enabled` gates click, role, and tab order (a non-clickable
 * row stays out of the tab sequence but keeps its child controls).
 */
export function useClickableRow(onActivate: () => void, enabled = true): ClickableRowProps {
	return {
		role: enabled ? "button" : undefined,
		tabindex: enabled ? 0 : -1,
		onClick: enabled ? onActivate : undefined,
		onKeyDown: (e: KeyboardEvent) => {
			// Only the row itself (not a nested control) activates.
			if (!enabled || e.target !== e.currentTarget) return;
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				onActivate();
			}
		},
	};
}
