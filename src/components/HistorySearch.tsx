import { createEffect, createSignal, For, onMount, type Component } from "solid-js";
import { fuzzyRank } from "../autocomplete";
import { PromptHistory } from "../history";
import { setPromptInsert } from "../state";
import { Modal } from "./Modal";
import { PickerRow } from "./PickerRow";

/**
 * Phase 7: Ctrl+R fuzzy search over prompt history (web affordance of the
 * TUI overlay). Enter/click inserts the entry into the PromptBox textarea;
 * Esc closes (Modal owns Esc). Entries are newest-first.
 */
export const HistorySearch: Component<{ onClose: () => void }> = (props) => {
	const [query, setQuery] = createSignal("");
	const [selected, setSelected] = createSignal(0);
	// Fresh instance per open so entries pushed this session are included
	// (PromptHistory persists every push to localStorage).
	const entries = new PromptHistory().list();
	let input!: HTMLInputElement;

	const filtered = () =>
		entries
			.map((text, index) => ({ text, index, rank: fuzzyRank(query(), text) }))
			.filter((x): x is { text: string; index: number; rank: number } => x.rank !== null)
			.sort((a, b) => a.rank - b.rank || a.index - b.index);

	createEffect(() => {
		query();
		setSelected(0);
	});

	const choose = (text: string) => {
		setPromptInsert({ text });
		props.onClose();
	};

	const onKeyDown = (e: KeyboardEvent) => {
		const list = filtered();
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setSelected((i) => Math.min(i + 1, list.length - 1));
			return;
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			setSelected((i) => Math.max(i - 1, 0));
			return;
		}
		if (e.key === "Enter") {
			e.preventDefault();
			const item = list[selected()];
			if (item) choose(item.text);
		}
	};

	onMount(() => input.focus());

	return (
		<Modal title="History search" onClose={props.onClose}>
			<input
				ref={input}
				class="history-search-input"
				aria-label="Search prompt history"
				placeholder="Search prompt history…"
				value={query()}
				onInput={(e) => setQuery(e.currentTarget.value)}
				onKeyDown={onKeyDown}
			/>
			<div class="picker-list">
				<For each={filtered()}>
					{(item, i) => (
						<PickerRow
							class="picker-row"
							classList={{ active: i() === selected() }}
							onClick={() => choose(item.text)}
							onMouseEnter={() => setSelected(i())}
						>
							<span class="picker-detail">{item.text}</span>
						</PickerRow>
					)}
				</For>
				{filtered().length === 0 && <div class="tool-collapsed-note">no matching history</div>}
			</div>
		</Modal>
	);
};
