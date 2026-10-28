import {
	createEffect,
	createMemo,
	createSignal,
	For,
	on,
	onCleanup,
	onMount,
	Show,
	type Component,
} from "solid-js";
import { state } from "../../state";
import { isImeKey } from "../../prompt/key-input";
import { recentModels } from "../../store/models";
import { searchAutofocus } from "../../store/integrations";
import { formatCtx } from "../../usage/model-options";
import { filterByKinds, virtualWindow } from "../../usage/model-query";
import { lockMessage, rankModels, type RankedModel } from "../../usage/model-search";
import { PickerRow } from "../ui/PickerRow";

/** Next keyboard cursor over `count` selectable rows; wraps at both ends, 0 when there are none. */
export function moveCursor(cursor: number, count: number, step: 1 | -1): number {
	if (count === 0) return 0;
	const current = Math.min(cursor, count - 1);
	return (current + step + count) % count;
}

/**
 * Searchable model list shared by the All models tab and the Roles tab's per-role
 * picker: fuzzy filter, Recent, locked rows disabled with their reason, and
 * arrow-key reach. Every keystroke re-ranks (a few ms over thousands of models);
 * rows are one line each at a fixed pitch and only the ones near the viewport are
 * mounted, so filtering and scrolling a large catalog stay cheap. `kinds` limits
 * the rows to those model kinds; absent shows all.
 * `onPick` resolves true when the pick was applied; `onPicked` runs only then.
 * The browser must be loaded by the owner.
 */
export const ModelSearchList: Component<{
	label: string;
	placeholder: string;
	currentSelector?: string;
	kinds?: readonly string[];
	onPick: (selector: string) => Promise<boolean>;
	onPicked: () => void;
	onEscape?: () => void;
}> = (props) => {
	const [query, setQuery] = createSignal("");
	const [cursor, setCursor] = createSignal(0);
	const [scrollTop, setScrollTop] = createSignal(0);
	// Estimates until the first rows mount and get measured.
	const [viewportHeight, setViewportHeight] = createSignal(600);
	const [rowPitch, setRowPitch] = createSignal(34);
	let inputEl: HTMLInputElement | undefined;
	let listEl: HTMLDivElement | undefined;

	const applyQuery = (next: string): void => {
		setQuery(next);
		setCursor(0);
		if (listEl) listEl.scrollTop = 0;
		setScrollTop(0);
	};

	const pool = createMemo(() => filterByKinds(state.modelBrowser ?? [], props.kinds));
	const rows = createMemo(() => rankModels(pool(), query(), recentModels(), props.currentSelector));
	const rowIndex = createMemo(
		() => new Map(rows().map((row, index) => [row.selector, index] as const)),
	);
	const selectable = createMemo(() => rows().filter((row) => row.model.locked === undefined));
	const selectableIndex = createMemo(
		() => new Map(selectable().map((row, index) => [row.selector, index] as const)),
	);
	const activeIndex = (): number => Math.min(cursor(), selectable().length - 1);
	const span = createMemo(() =>
		virtualWindow(scrollTop(), viewportHeight(), rowPitch(), rows().length),
	);
	const visible = createMemo(() => rows().slice(span().start, span().end));

	/**
	 * Viewport height, and the row pitch (height plus gap) from two mounted rows. The
	 * pitch is measured once (again only after a resize) and with fractional geometry:
	 * re-deriving it from whole-pixel offsets on every window change alternated
	 * between two values, each shifting the window and re-measuring, which never ended.
	 */
	let pitchMeasured = false;
	const measure = (): void => {
		if (!listEl) return;
		setViewportHeight(listEl.clientHeight);
		if (pitchMeasured) return;
		const mounted = listEl.querySelectorAll<HTMLElement>(".model-row");
		if (mounted.length < 2) return;
		const pitch = mounted[1].getBoundingClientRect().top - mounted[0].getBoundingClientRect().top;
		if (pitch <= 0) return;
		pitchMeasured = true;
		setRowPitch(pitch);
	};
	const resizes = new ResizeObserver(() => {
		pitchMeasured = false;
		measure();
	});
	onCleanup(() => resizes.disconnect());

	const activate = async (row: RankedModel): Promise<void> => {
		if (await props.onPick(row.selector)) props.onPicked();
	};

	/**
	 * Scroll the keyboard row into view after an arrow key (never on hover, which would
	 * creep the list under the pointer). A row outside the mounted window is first
	 * brought into it by index; once mounted, the row itself scrolls into view exactly.
	 */
	const revealActive = (): void => {
		const row = selectable()[activeIndex()];
		const at = row ? rowIndex().get(row.selector) : undefined;
		const list = listEl;
		if (at === undefined || !list) return;
		const { start, end } = span();
		if (at < start || at >= end) {
			list.scrollTop = at * rowPitch();
			setScrollTop(list.scrollTop);
		}
		list.querySelector(".model-row.kbd-active")?.scrollIntoView({ block: "nearest" });
	};

	const onKeyDown = (e: KeyboardEvent): void => {
		if (isImeKey(e)) return;
		if (e.key === "Escape" && props.onEscape) {
			e.preventDefault();
			e.stopPropagation();
			props.onEscape();
			return;
		}
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			setCursor(moveCursor(activeIndex(), selectable().length, e.key === "ArrowDown" ? 1 : -1));
			revealActive();
			return;
		}
		if (e.key === "Enter" && e.target === inputEl) {
			e.preventDefault();
			const row = selectable()[activeIndex()];
			if (row) void activate(row);
		}
	};

	// Not on a touch screen: the keyboard would cover the list the picker opens on.
	onMount(() => {
		if (searchAutofocus()) inputEl?.focus();
	});

	createEffect(
		on(visible, () => {
			if (!pitchMeasured) requestAnimationFrame(measure);
		}),
	);

	return (
		<div class="model-search" onKeyDown={onKeyDown}>
			<input
				ref={(el) => {
					inputEl = el;
				}}
				class="picker-filter"
				type="search"
				placeholder={props.placeholder}
				autocomplete="off"
				autocapitalize="off"
				spellcheck={false}
				aria-label={props.label}
				onInput={(e) => applyQuery(e.currentTarget.value)}
			/>
			<Show when={state.modelBrowser} fallback={<p class="picker-detail">Loading models...</p>}>
				<Show when={rows().length > 0} fallback={<p class="picker-detail">No models match.</p>}>
					<div
						class="picker-list model-picker-list"
						ref={(el) => {
							listEl = el;
							resizes.observe(el);
						}}
						onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
					>
						<div
							class="model-picker-window"
							style={{
								"padding-top": `${span().start * rowPitch()}px`,
								"padding-bottom": `${(rows().length - span().end) * rowPitch()}px`,
							}}
						>
							<For each={visible()}>
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
					</div>
				</Show>
			</Show>
		</div>
	);
};
