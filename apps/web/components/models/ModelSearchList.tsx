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
import { recentModels } from "../../store/models";
import { formatCtx } from "../../usage/model-options";
import { lockMessage, rankModels, type RankedModel } from "../../usage/model-search";
import { PickerRow } from "../ui/PickerRow";

/** Next keyboard cursor over `count` selectable rows; wraps at both ends, 0 when there are none. */
export function moveCursor(cursor: number, count: number, step: 1 | -1): number {
	if (count === 0) return 0;
	const current = Math.min(cursor, count - 1);
	return (current + step + count) % count;
}

/**
 * Searchable model list shared by the composer's quick picker and the Settings
 * role rows: fuzzy filter, Recent, locked rows disabled with their reason, and
 * arrow-key reach. `onPick` resolves true when the pick was applied; `onPicked`
 * runs only then. The browser must be loaded by the owner.
 */
export const ModelSearchList: Component<{
	label: string;
	placeholder: string;
	currentSelector?: string;
	onPick: (selector: string) => Promise<boolean>;
	onPicked: () => void;
	onEscape?: () => void;
}> = (props) => {
	const [query, setQuery] = createSignal("");
	const [cursor, setCursor] = createSignal(0);
	let inputEl: HTMLInputElement | undefined;
	let listEl: HTMLDivElement | undefined;

	const rows = createMemo(() =>
		rankModels(state.modelBrowser ?? [], query(), recentModels(), props.currentSelector),
	);
	const selectable = createMemo(() => rows().filter((row) => row.model.locked === undefined));
	const selectableIndex = createMemo(
		() => new Map(selectable().map((row, index) => [row.selector, index] as const)),
	);
	const activeIndex = (): number => Math.min(cursor(), selectable().length - 1);

	const activate = async (row: RankedModel): Promise<void> => {
		if (await props.onPick(row.selector)) props.onPicked();
	};

	const onKeyDown = (e: KeyboardEvent): void => {
		if (e.key === "Escape" && props.onEscape) {
			e.preventDefault();
			e.stopPropagation();
			props.onEscape();
			return;
		}
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			setCursor(moveCursor(activeIndex(), selectable().length, e.key === "ArrowDown" ? 1 : -1));
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
	});

	createEffect(() => {
		const index = activeIndex();
		listEl?.querySelectorAll<HTMLElement>("button:not(:disabled)")[index]?.scrollIntoView({
			block: "nearest",
		});
	});

	return (
		<div class="model-search" onKeyDown={onKeyDown}>
			<input
				ref={(el) => {
					inputEl = el;
				}}
				class="picker-filter"
				type="search"
				placeholder={props.placeholder}
				aria-label={props.label}
				value={query()}
				onInput={(e) => {
					setQuery(e.currentTarget.value);
					setCursor(0);
				}}
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
								const isCurrent = (): boolean => row.selector === props.currentSelector;
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
	);
};
