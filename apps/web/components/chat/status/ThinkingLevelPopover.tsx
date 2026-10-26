import { For, Show, type Component } from "solid-js";
import { state } from "../../../state";
import { setThinkingSelector } from "../../../store/models";
import {
	currentThinkingSelector,
	thinkingLabel,
	thinkingOrdinal,
} from "../../../usage/model-search";
import { CheckIcon } from "../../ui/icons";
import { Popover } from "../../ui/Popover";
import { moveRovingFocus, setRovingTabStop } from "../../ui/roving";

/**
 * Thinking-level dropdown above the bar's thinking chip: the levels the current model
 * supports with the active one checked and its place on the ladder ("N of M"). Arrow keys
 * move, Enter picks, Escape closes; a pick closes it once the session accepted the level.
 */
export const ThinkingLevelPopover: Component<{ anchor: HTMLElement; onClose: () => void }> = (
	props,
) => {
	let listEl: HTMLDivElement | undefined;

	const selectors = (): string[] => state.thinkingSelectors ?? [];
	const current = (): string => currentThinkingSelector(state.autoThinking, state.thinkingLevel);
	const ordinal = () => thinkingOrdinal(selectors(), current());
	const items = (): HTMLButtonElement[] =>
		Array.from(listEl?.querySelectorAll<HTMLButtonElement>("button") ?? []);

	const choose = async (level: string): Promise<void> => {
		if (!(await setThinkingSelector(level))) return;
		// Focus returns to the chip before the popover unmounts, so it is not lost to the body.
		props.anchor.focus();
		props.onClose();
	};

	const initialFocus = (): HTMLElement | undefined => {
		const buttons = items();
		const checked = buttons.findIndex((b) => b.getAttribute("aria-pressed") === "true");
		const at = Math.max(0, checked);
		setRovingTabStop(buttons, at);
		return buttons[at];
	};

	const onKeyDown = (e: KeyboardEvent): void => {
		const buttons = items();
		moveRovingFocus(
			e,
			buttons,
			buttons.indexOf(document.activeElement as HTMLButtonElement),
			"vertical",
			true,
		);
	};

	return (
		<Popover
			anchor={props.anchor}
			onClose={props.onClose}
			label="Thinking level"
			class="status-menu"
			width={220}
			initialFocus={initialFocus}
		>
			<Show
				when={selectors().length > 0}
				fallback={<p class="status-menu-empty">This model has no thinking levels.</p>}
			>
				<div class="thinking-ordinal status-menu-head" aria-hidden="true">
					<For each={selectors()}>
						{(_level, index) => (
							<span
								class="thinking-ordinal-seg"
								classList={{ filled: ordinal().index >= 0 && index() <= ordinal().index }}
							/>
						)}
					</For>
					<span class="thinking-ordinal-text">
						{ordinal().index >= 0
							? `${ordinal().index + 1} of ${ordinal().count}`
							: "not on this ladder"}
					</span>
				</div>
				<div
					class="status-menu-list"
					ref={(el) => {
						listEl = el;
					}}
					onKeyDown={onKeyDown}
				>
					<For each={selectors()}>
						{(level) => (
							<button
								type="button"
								class="status-menu-item"
								tabindex="-1"
								aria-pressed={level === current()}
								onClick={() => void choose(level)}
							>
								<span class="status-menu-check">
									<Show when={level === current()}>
										<CheckIcon />
									</Show>
								</span>
								<span class="status-menu-label">{thinkingLabel(level)}</span>
							</button>
						)}
					</For>
				</div>
			</Show>
		</Popover>
	);
};
