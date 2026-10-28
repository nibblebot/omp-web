import { createMemo, createResource, createSignal, For, Show, type Component } from "solid-js";
import { flattenPalette, searchPalette, type PaletteItem } from "../../palette/palette";
import { paletteSources, runPaletteItem, searchStoredSessions } from "../../store/palette";
import { ensureSettingsModel } from "../../store/settings";
import { reportError } from "../../store/toasts";
import { Modal } from "../ui/Modal";
import { PickerRow } from "../ui/PickerRow";

/**
 * Ctrl+K command palette: one search over commands, open targets, sessions in
 * every project, settings rows and models. Ranking is `searchPalette`; the
 * stored-session search is a server round trip, so it runs per query.
 */
export const CommandPalettePicker: Component<{ onClose: () => void }> = (props) => {
	// The settings rows come from the model, which loads on first use rather than at attach.
	ensureSettingsModel();
	const [query, setQuery] = createSignal("");
	const [active, setActive] = createSignal(0);
	const [stored] = createResource(query, async (q) => {
		if (q.trim() === "") return [];
		try {
			return await searchStoredSessions(q);
		} catch (err) {
			reportError(err);
			return [];
		}
	});
	const sections = createMemo(() =>
		searchPalette(query(), paletteSources(query(), stored() ?? [])),
	);
	const items = createMemo(() => flattenPalette(sections()));

	const run = (item: PaletteItem) => runPaletteItem(item);
	const onKeyDown = (e: KeyboardEvent) => {
		const count = items().length;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setActive((i) => Math.min(i + 1, count - 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setActive((i) => Math.max(i - 1, 0));
		} else if (e.key === "Enter") {
			const item = items()[active()];
			if (item === undefined) return;
			e.preventDefault();
			run(item);
		}
	};

	return (
		<Modal title="Command palette" class="command-palette-dialog" onClose={props.onClose}>
			<input
				class="picker-filter"
				type="search"
				placeholder="Search commands, sessions, settings, models"
				aria-label="Search the command palette"
				value={query()}
				onInput={(e) => {
					setQuery(e.currentTarget.value);
					setActive(0);
				}}
				onKeyDown={onKeyDown}
				autofocus
			/>
			<div class="picker-list" role="listbox" aria-label="Palette results">
				<For each={sections()}>
					{(section) => (
						<div role="group" aria-label={section.group}>
							<div class="picker-group-name">{section.group}</div>
							<For each={section.items}>
								{(item) => {
									const index = () => items().indexOf(item);
									return (
										<PickerRow
											class="picker-row"
											classList={{ active: index() === active() }}
											aria-selected={index() === active()}
											title={item.detail}
											onClick={() => run(item)}
											onMouseEnter={() => setActive(index())}
										>
											<span>{item.label}</span>
											<Show when={item.detail}>
												{(detail) => <span class="picker-meta">{detail()}</span>}
											</Show>
											<Show when={item.live}>
												{(live) => <span class="picker-meta">{live()}</span>}
											</Show>
											<Show when={item.chip}>
												{(chip) => <span class="picker-meta">{chip()}</span>}
											</Show>
											<Show when={item.hint}>{(hint) => <kbd>{hint()}</kbd>}</Show>
										</PickerRow>
									);
								}}
							</For>
						</div>
					)}
				</For>
			</div>
			<Show when={items().length === 0}>
				<p class="picker-meta">No matches</p>
			</Show>
		</Modal>
	);
};
