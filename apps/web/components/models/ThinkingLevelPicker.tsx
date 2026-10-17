import { For, onMount, Show, type Component } from "solid-js";
import { state } from "../../state";
import { closeThinkingPicker, setThinkingSelector } from "../../store/models";
import { thinkingLabel, thinkingOrdinal } from "../../usage/model-search";
import { Modal } from "../ui/Modal";
import { PickerRow } from "../ui/PickerRow";

/** Thinking picker: lists the levels the current model supports, current one marked. */
export const ThinkingLevelPicker: Component<{ onClose: () => void }> = (props) => {
	let listEl: HTMLDivElement | undefined;

	const selectors = (): string[] => state.thinkingSelectors ?? [];
	const current = (): string => (state.autoThinking ? "auto" : (state.thinkingLevel ?? "inherit"));
	const ordinal = () => thinkingOrdinal(selectors(), current());

	const choose = async (level: string): Promise<void> => {
		if (await setThinkingSelector(level)) closeThinkingPicker();
	};

	const onKeyDown = (e: KeyboardEvent): void => {
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
		const buttons = Array.from(listEl?.querySelectorAll<HTMLButtonElement>("button") ?? []);
		if (buttons.length === 0) return;
		e.preventDefault();
		const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
		const step = e.key === "ArrowDown" ? 1 : -1;
		buttons[(at + step + buttons.length) % buttons.length]?.focus();
	};

	onMount(() => {
		const focusTarget =
			listEl?.querySelector<HTMLButtonElement>("button[aria-pressed='true']") ??
			listEl?.querySelector<HTMLButtonElement>("button");
		focusTarget?.focus();
	});

	return (
		<Modal title="Thinking" onClose={props.onClose}>
			<div class="thinking-picker" onKeyDown={onKeyDown}>
				<Show
					when={selectors().length > 0}
					fallback={<p class="picker-detail">This model has no thinking levels.</p>}
				>
					<div class="thinking-ordinal" aria-hidden="true">
						<For each={selectors()}>
							{(_level, index) => (
								<span
									class="thinking-ordinal-seg"
									classList={{
										filled: ordinal().index >= 0 && index() <= ordinal().index,
									}}
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
						class="picker-list thinking-list"
						ref={(el) => {
							listEl = el;
						}}
					>
						<For each={selectors()}>
							{(level) => (
								<PickerRow
									class="picker-row thinking-row"
									classList={{ active: level === current() }}
									aria-pressed={level === current()}
									onClick={() => void choose(level)}
								>
									<span class="picker-label">{thinkingLabel(level)}</span>
									<Show when={level === current()}>
										<span class="picker-chip">current</span>
									</Show>
								</PickerRow>
							)}
						</For>
					</div>
				</Show>
			</div>
		</Modal>
	);
};
