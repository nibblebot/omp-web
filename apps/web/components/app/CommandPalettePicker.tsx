import {
	createMemo,
	createResource,
	createSignal,
	For,
	onCleanup,
	onMount,
	Show,
	type Component,
} from "solid-js";
import { flattenPalette, searchPalette, type PaletteItem } from "../../palette/palette";
import {
	paletteSources,
	runPaletteItem,
	searchStoredSessions,
	STORED_SESSIONS_MIN_QUERY,
} from "../../store/palette";
import { isImeKey } from "../../prompt/key-input";
import { searchAutofocus } from "../../store/integrations";
import { ensureSettingsModel } from "../../store/settings";
import { createDebouncer } from "../../store/search-debounce";
import { reportError } from "../../store/toasts";
import { Modal } from "../ui/Modal";
import { PickerRow } from "../ui/PickerRow";

/**
 * Ctrl+K command palette: one search over commands, open targets, sessions in
 * every project, settings rows and models. Ranking is `searchPalette`; the
 * stored-session search is a server round trip that scans every transcript, so it
 * runs once per typing pause (not per keystroke) and only for a query long enough
 * to mean something. Everything else filters as you type.
 */
export const CommandPalettePicker: Component<{ onClose: () => void }> = (props) => {
	// The settings rows come from the model, which loads on first use rather than at attach.
	ensureSettingsModel();
	const [query, setQuery] = createSignal("");
	const [active, setActive] = createSignal(0);
	const [settled, setSettled] = createSignal("");
	const pause = createDebouncer();
	onCleanup(pause.cancel);
	const [stored] = createResource(
		() => (settled().trim().length >= STORED_SESSIONS_MIN_QUERY ? settled() : false),
		async (q) => {
			try {
				return await searchStoredSessions(q);
			} catch (err) {
				reportError(err);
				return [];
			}
		},
	);
	/** The previous answer stays up while a newer search runs; a query too short to search shows none. */
	const storedRows = () =>
		query().trim().length >= STORED_SESSIONS_MIN_QUERY ? (stored() ?? []) : [];
	const sections = createMemo(() => searchPalette(query(), paletteSources(query(), storedRows())));
	const items = createMemo(() => flattenPalette(sections()));

	let search!: HTMLInputElement;
	let list!: HTMLDivElement;
	onMount(() => {
		// Modal focuses its own box when it mounts; the microtask runs after that.
		if (searchAutofocus()) queueMicrotask(() => search.focus());
	});

	const run = (item: PaletteItem) => runPaletteItem(item);
	/** Keyboard moves keep the active row in view; pointer hover never scrolls. */
	const move = (index: number) => {
		setActive(index);
		list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
	};
	const onKeyDown = (e: KeyboardEvent) => {
		if (isImeKey(e)) return;
		const count = items().length;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			move(Math.min(active() + 1, count - 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			move(Math.max(active() - 1, 0));
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
				ref={search}
				class="picker-filter"
				type="search"
				placeholder="Search commands, sessions, settings, models"
				autocomplete="off"
				autocapitalize="off"
				spellcheck={false}
				aria-label="Search the command palette"
				value={query()}
				onInput={(e) => {
					const value = e.currentTarget.value;
					setQuery(value);
					pause.schedule(() => setSettled(value));
					setActive(0);
				}}
				onKeyDown={onKeyDown}
			/>
			<div ref={list} class="picker-list" role="listbox" aria-label="Palette results">
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
