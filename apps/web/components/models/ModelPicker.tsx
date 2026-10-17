import {
	createEffect,
	createMemo,
	createSignal,
	For,
	onMount,
	Show,
	type Component,
} from "solid-js";
import { state } from "../../state";
import {
	clearTaskModel,
	closeModelPicker,
	loadModelBrowser,
	openModelPicker,
	pickTaskModel,
	recentModels,
	switchSessionModel,
} from "../../store/models";
import { formatCtx } from "../../usage/model-options";
import { lockMessage, rankModels, type RankedModel } from "../../usage/model-search";
import { Modal } from "../ui/Modal";
import { PickerRow } from "../ui/PickerRow";

/** Quick model picker (Alt+P). Session-only switch, or the Task-model override when opened in Task mode. */
export const ModelPicker: Component<{ onClose: () => void }> = (props) => {
	const [query, setQuery] = createSignal("");
	const [cursor, setCursor] = createSignal(0);
	let inputEl: HTMLInputElement | undefined;
	let listEl: HTMLDivElement | undefined;

	const currentSelector = (): string | undefined =>
		state.model ? `${state.model.provider}/${state.model.id}` : undefined;
	const rows = createMemo(() =>
		rankModels(state.modelBrowser ?? [], query(), recentModels(), currentSelector()),
	);
	const selectable = createMemo(() => rows().filter((row) => row.model.locked === undefined));
	const selectableIndex = createMemo(
		() => new Map(selectable().map((row, index) => [row.selector, index] as const)),
	);
	const activeIndex = (): number => Math.min(cursor(), selectable().length - 1);

	const activate = async (row: RankedModel): Promise<void> => {
		const ok = state.modelPickerTask
			? await pickTaskModel(row.selector)
			: await switchSessionModel(row.selector);
		if (ok) closeModelPicker();
	};

	const onInput = (value: string): void => {
		setQuery(value);
		setCursor(0);
	};

	const onKeyDown = (e: KeyboardEvent): void => {
		const count = selectable().length;
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			if (count === 0) return;
			const step = e.key === "ArrowDown" ? 1 : -1;
			setCursor((activeIndex() + step + count) % count);
			return;
		}
		if (e.key === "Enter" && e.target === inputEl) {
			e.preventDefault();
			const row = selectable()[activeIndex()];
			if (row) void activate(row);
		}
	};

	onMount(() => {
		inputEl?.focus();
		void loadModelBrowser();
	});

	createEffect(() => {
		const index = activeIndex();
		listEl?.querySelectorAll<HTMLElement>("button:not(:disabled)")[index]?.scrollIntoView({
			block: "nearest",
		});
	});

	return (
		<Modal title="Model" onClose={props.onClose}>
			<div class="model-picker" onKeyDown={onKeyDown}>
				<p class="picker-detail">
					Session-only. Roles unchanged. Set as default in Settings &gt; Model.
				</p>
				<div class="model-picker-task">
					<button
						type="button"
						class="picker-row-action"
						aria-pressed={!!state.modelPickerTask}
						title="Pick the model used by Task subagents"
						onClick={() => openModelPicker(!state.modelPickerTask)}
					>
						Task model: {state.taskModel ?? "inherits session model"}
					</button>
					<Show when={state.taskModel}>
						<button type="button" class="picker-row-action" onClick={() => void clearTaskModel()}>
							Clear
						</button>
					</Show>
				</div>
				<input
					ref={(el) => {
						inputEl = el;
					}}
					class="picker-filter"
					type="search"
					placeholder={state.modelPickerTask ? "Search models for Task" : "Search models"}
					aria-label="Search models"
					value={query()}
					onInput={(e) => onInput(e.currentTarget.value)}
				/>
				<Show when={state.modelBrowser} fallback={<p class="picker-detail">Loading models...</p>}>
					<Show when={rows().length > 0} fallback={<p class="picker-detail">No models match.</p>}>
						<div
							class="picker-list model-picker-list"
							ref={(el) => {
								listEl = el;
							}}
						>
							<For each={rows()}>
								{(row) => {
									const index = (): number => selectableIndex().get(row.selector) ?? -1;
									const isCurrent = (): boolean => row.selector === currentSelector();
									return (
										<PickerRow
											class="picker-row model-row"
											classList={{
												active: isCurrent(),
												"kbd-active": index() >= 0 && index() === activeIndex(),
											}}
											disabled={row.model.locked !== undefined}
											title={row.model.locked && lockMessage(row.model.locked, row.model.provider)}
											onClick={() => void activate(row)}
											onMouseEnter={() => {
												if (index() >= 0) setCursor(index());
											}}
										>
											<span class="picker-label">{row.selector}</span>
											<Show when={row.recent}>
												<span class="picker-detail">Recent</span>
											</Show>
											<Show when={row.model.reasoning}>
												<span class="picker-chip">reasoning</span>
											</Show>
											<Show when={isCurrent()}>
												<span class="picker-chip">current</span>
											</Show>
											<Show when={formatCtx(row.model.contextWindow)}>
												{(ctx) => <span class="picker-meta">{ctx()}</span>}
											</Show>
											<Show when={row.model.locked}>
												{(reason) => (
													<span class="picker-detail">
														{lockMessage(reason(), row.model.provider)}
													</span>
												)}
											</Show>
										</PickerRow>
									);
								}}
							</For>
						</div>
					</Show>
				</Show>
			</div>
		</Modal>
	);
};
