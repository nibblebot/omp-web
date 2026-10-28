import { createSignal, For, Show, type Component } from "solid-js";
import {
	moveSelected,
	orderedRows,
	reorderSelected,
	toggleSelected,
} from "../../../prefs/setting-controls";
import type { SettingsOption } from "#lib/wire/protocol";
import { ArrowDownIcon, ArrowUpIcon, GripVerticalIcon } from "../../ui/icons";
import { SettingToggle } from "./SettingToggle";

/** A pointer drag in progress: the dragged value, its rank, and the drop slot (an index into the enabled order). */
type Drag = { value: string; from: number; before: number };

/**
 * Enabled entries in run order, each with a drag handle and index, then the
 * disabled ones with only a switch. Order matters for the enabled entries, so
 * only they can move: drag the grip, or focus a row and press Alt+↑/↓.
 */
export const SettingOrderedList: Component<{
	label: string;
	options: SettingsOption[];
	selected: string[];
	disabled?: boolean;
	onChange: (selected: string[]) => void;
}> = (props) => {
	const [drag, setDrag] = createSignal<Drag | null>(null);
	let list: HTMLOListElement | undefined;

	/** Drop slot for a pointer position: the first enabled row whose midline lies below it. */
	const dropSlot = (clientY: number): number => {
		const rows = list?.querySelectorAll<HTMLElement>("li[data-rank]") ?? [];
		for (let i = 0; i < rows.length; i++) {
			const box = rows[i]!.getBoundingClientRect();
			if (clientY < box.top + box.height / 2) return i;
		}
		return rows.length;
	};

	const onGripDown = (e: PointerEvent, value: string, rank: number) => {
		if (props.disabled || e.button !== 0) return;
		e.preventDefault();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		setDrag({ value, from: rank, before: rank });
	};

	const onGripMove = (e: PointerEvent) => {
		const current = drag();
		if (current) setDrag({ ...current, before: dropSlot(e.clientY) });
	};

	const onGripUp = () => {
		const current = drag();
		setDrag(null);
		if (!current) return;
		const next = reorderSelected(props.selected, current.value, current.before);
		if (next !== props.selected) props.onChange(next);
	};

	/** Swap an enabled entry with its neighbour; false when it is already at that end. */
	const applyMove = (value: string, direction: -1 | 1): boolean => {
		const next = moveSelected(props.selected, value, direction);
		if (next === props.selected) return false;
		props.onChange(next);
		return true;
	};

	/** Alt+↑/↓ moves the focused enabled row; focus follows it to its new rank once the list re-renders. */
	const onRowKey = (e: KeyboardEvent, value: string, rank: number) => {
		if (!e.altKey || props.disabled) return;
		const direction = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
		if (direction === 0) return;
		e.preventDefault();
		if (!applyMove(value, direction)) return;
		const target = rank + direction;
		requestAnimationFrame(() =>
			list?.querySelector<HTMLElement>(`li[data-rank="${target}"]`)?.focus(),
		);
	};

	/** The Up/Down buttons (visible on touch): move one rank, then keep focus on a move button of the row's new slot. */
	const onMoveClick = (value: string, rank: number, direction: -1 | 1) => {
		if (!applyMove(value, direction)) return;
		const target = rank + direction;
		requestAnimationFrame(() => {
			const buttons = list?.querySelectorAll<HTMLButtonElement>(
				`li[data-rank="${target}"] button[data-move]:not(:disabled)`,
			);
			const same = Array.from(buttons ?? []).find((b) => b.dataset.move === String(direction));
			(same ?? buttons?.[0])?.focus();
		});
	};

	return (
		<ol class="settings-ordered-list" aria-label={props.label} ref={(el) => (list = el)}>
			<For each={orderedRows(props.options, props.selected)}>
				{(row) => {
					const rank = row.rank;
					const enabled = rank !== undefined;
					const value = row.option.value;
					return (
						<li
							class="settings-ordered-row"
							classList={{
								off: !enabled,
								dragging: drag()?.value === value,
								"drop-before": enabled && drag()?.before === rank && drag()?.value !== value,
								"drop-after":
									enabled &&
									rank === props.selected.length - 1 &&
									drag()?.before === props.selected.length,
							}}
							data-rank={rank}
							tabIndex={enabled && !props.disabled ? 0 : undefined}
							aria-description={
								enabled && !props.disabled
									? "Press Alt+ArrowUp or Alt+ArrowDown to move"
									: undefined
							}
							onKeyDown={(e) => enabled && onRowKey(e, value, rank)}
						>
							<Show
								when={enabled}
								fallback={<span class="settings-ordered-grip-slot" aria-hidden="true" />}
							>
								<span
									class="settings-ordered-grip"
									classList={{ disabled: props.disabled }}
									aria-hidden="true"
									title="Drag to reorder, or focus the row and press Alt+↑/↓"
									onPointerDown={(e) => rank !== undefined && onGripDown(e, value, rank)}
									onPointerMove={onGripMove}
									onPointerUp={onGripUp}
									onPointerCancel={() => setDrag(null)}
								>
									<GripVerticalIcon />
								</span>
							</Show>
							<span class="settings-ordered-rank">{enabled ? rank + 1 : ""}</span>
							<span class="settings-ordered-text">
								<span class="settings-ordered-name">{row.option.label}</span>
								<Show when={row.option.description}>
									<span class="settings-ordered-desc">{row.option.description}</span>
								</Show>
							</span>
							<span class="settings-ordered-actions">
								<Show when={enabled && !props.disabled}>
									<span class="settings-ordered-move">
										<button
											type="button"
											data-move="-1"
											aria-label={`Move ${row.option.label} up`}
											disabled={rank === 0}
											onClick={() => rank !== undefined && onMoveClick(value, rank, -1)}
										>
											<ArrowUpIcon />
										</button>
										<button
											type="button"
											data-move="1"
											aria-label={`Move ${row.option.label} down`}
											disabled={rank === props.selected.length - 1}
											onClick={() => rank !== undefined && onMoveClick(value, rank, 1)}
										>
											<ArrowDownIcon />
										</button>
									</span>
								</Show>
								<SettingToggle
									label={row.option.label}
									checked={enabled}
									disabled={props.disabled}
									onChange={() => props.onChange(toggleSelected(props.selected, value))}
								/>
							</span>
						</li>
					);
				}}
			</For>
		</ol>
	);
};
