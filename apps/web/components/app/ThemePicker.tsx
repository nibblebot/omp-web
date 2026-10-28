import {
	createMemo,
	createSignal,
	createUniqueId,
	For,
	onCleanup,
	onMount,
	Show,
	type Component,
} from "solid-js";
import { DEFAULT_THEME_ID } from "#lib/themes/types";
import type { ThemeEntry, ThemeScheme } from "#lib/themes/types";
import { effectiveScheme, unavailableSchemes } from "../../prefs/theme";
import { chooseLinkedTheme, chooseSchemeTheme, state } from "../../state";
import { CheckIcon, ChevronDownIcon } from "../ui/icons";
import { moveRovingFocus } from "../ui/roving";
import {
	themeOptions,
	themeVariantKey,
	typeAheadIndex,
	type ThemeOption,
	type ThemePickerKind,
} from "../../prefs/theme-picker";

const SCHEME_LABEL: Record<ThemeScheme, string> = { dark: "Dark", light: "Light" };
/** Type-ahead typing pauses longer than this start a new prefix. */
const TYPE_AHEAD_MS = 700;

/** The scheme in effect, following the OS while the mode is System (effectiveScheme reads it, so an OS change bumps the memo). */
function createEffectiveScheme(): () => ThemeScheme {
	const [osChanges, setOsChanges] = createSignal(0);
	onMount(() => {
		const query = window.matchMedia("(prefers-color-scheme: light)");
		const onChange = () => setOsChanges((n) => n + 1);
		query.addEventListener("change", onChange);
		onCleanup(() => query.removeEventListener("change", onChange));
	});
	return createMemo(() => {
		void osChanges();
		return effectiveScheme(state.themeSelection);
	});
}

/** A variant's colors in miniature: its own background with text and accent bars. */
const Swatch: Component<{ id: string; scheme: ThemeScheme }> = (props) => (
	<span class="theme-swatch" data-theme-variant={themeVariantKey(props.id, props.scheme)}>
		<span class="theme-swatch-text" />
		<span class="theme-swatch-accent" />
	</span>
);

/**
 * One variant of a row, painted in its own colors (the half carries its own
 * `data-theme-variant`): the theme name as sample text, the scheme, a strip of the
 * accent and status colors, and the "modified" badge (once per row).
 */
const OptionHalf: Component<{
	entry: ThemeEntry;
	scheme: ThemeScheme;
	showModified: boolean;
}> = (props) => (
	<span class="theme-half" data-theme-variant={themeVariantKey(props.entry.id, props.scheme)}>
		<span class="theme-half-name">{props.entry.name}</span>
		<span class="theme-half-meta">
			<span class="theme-half-scheme">{SCHEME_LABEL[props.scheme]}</span>
			<span class="theme-half-strip">
				<span class="theme-chip theme-chip-accent" />
				<span class="theme-chip theme-chip-success" />
				<span class="theme-chip theme-chip-warning" />
				<span class="theme-chip theme-chip-error" />
			</span>
			<Show when={props.showModified && props.entry.source === "modified"}>
				<span class="theme-badge">modified</span>
			</Show>
		</span>
	</span>
);

/** What a screen reader hears after the theme name: its variants, source and use. */
function optionDescription(option: ThemeOption, selectedScheme: ThemeScheme | null): string {
	const parts = [option.schemes.map((s) => SCHEME_LABEL[s]).join(" and ") + " variant"];
	if (option.schemes.length > 1) parts[0] += "s";
	if (option.entry.source === "modified") parts.push("Modified built-in theme");
	if (selectedScheme) parts.push(`${SCHEME_LABEL[selectedScheme]} is in use`);
	return parts.join(". ");
}

/**
 * Custom listbox of themes (never a native select), disclosed inline under its trigger so
 * it lives inside the Appearance sheet without a second portal. `kind="linked"` lists every
 * theme as one row split into its dark and light halves; `kind="light"` / `"dark"` is the
 * unlinked picker of that scheme, full-width rows of the themes that have it. Each half paints
 * itself with its variant's own colors. Choosing a theme (click, Enter or Space) applies it
 * and keeps the list open so several themes can be tried in turn. Keyboard follows the APG
 * listbox: Arrow keys, Home, End and type-ahead move focus, Escape closes and returns focus
 * to the trigger (without closing the surrounding sheet), Tab leaves. `floating` lets the
 * list overlay the page (top bar) instead of pushing the content below it, and
 * `defaultOpen` mounts it with the list showing (stories).
 */
export const ThemePicker: Component<{
	kind: ThemePickerKind;
	/** Accessible name: "Theme", "Light theme" or "Dark theme". */
	label: string;
	floating?: boolean;
	defaultOpen?: boolean;
}> = (props) => {
	const id = createUniqueId();
	const triggerId = `${id}-trigger`;
	const labelId = `${id}-label`;
	const listId = `${id}-list`;
	const [open, setOpen] = createSignal(props.defaultOpen ?? false);
	// The option focus last sat on (-1: none yet, so the selected row, else the first, is the tab stop).
	const [active, setActive] = createSignal(-1);
	let root!: HTMLDivElement;
	let trigger!: HTMLButtonElement;
	let list: HTMLDivElement | undefined;
	let typed = "";
	let typedAt = 0;
	const inUseScheme = createEffectiveScheme();

	const themes = () => state.themes?.themes ?? [];
	const options = createMemo(() => themeOptions(themes(), props.kind));
	// The scheme whose stored id the trigger shows: the dark one for the linked picker (both ids match while linked).
	const selectedScheme = (): ThemeScheme => (props.kind === "linked" ? "dark" : props.kind);
	const selectedId = () => state.themeSelection[selectedScheme()];
	const missing = createMemo(() =>
		unavailableSchemes(state.themes, state.themeSelection).filter(
			(scheme) => props.kind === "linked" || scheme === props.kind,
		),
	);
	// What renders when the stored theme is gone: the default, as the app itself does.
	const shownEntry = createMemo((): ThemeEntry | undefined => {
		const all = themes();
		const wanted = missing().includes(selectedScheme()) ? DEFAULT_THEME_ID : selectedId();
		return all.find((t) => t.id === wanted);
	});
	const shownSchemes = (): ThemeScheme[] =>
		options().find((o) => o.entry.id === shownEntry()?.id)?.schemes ?? [];
	const selectedIndex = () => options().findIndex((o) => o.entry.id === selectedId());
	const tabStop = () => (active() >= 0 ? active() : Math.max(selectedIndex(), 0));
	const items = () => Array.from(list?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);

	const close = (refocus: boolean) => {
		setOpen(false);
		setActive(-1);
		if (refocus) trigger.focus();
	};
	const openList = () => {
		setOpen(true);
		queueMicrotask(() => items()[tabStop()]?.focus());
	};
	// Applies the theme and leaves the list open, so the user can click through several themes.
	// A single-variant pick in the linked picker unlinks and replaces this picker entirely.
	const choose = (index: number) => {
		const option = options()[index];
		if (!option) return;
		setActive(index);
		if (props.kind === "linked") chooseLinkedTheme(option.entry.id);
		else chooseSchemeTheme(props.kind, option.entry.id);
	};

	const onListKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Escape") {
			// The list carries data-inline-escape, so the surrounding Modal leaves this Escape to it.
			e.preventDefault();
			e.stopPropagation();
			close(true);
			return;
		}
		if (e.key === "Tab") {
			close(false);
			return;
		}
		const els = items();
		const current = els.indexOf(document.activeElement as HTMLElement);
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			if (current >= 0) choose(current);
			return;
		}
		if (moveRovingFocus(e, els, current, "vertical") !== null) return;
		if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
		const now = Date.now();
		typed = now - typedAt > TYPE_AHEAD_MS ? e.key : typed + e.key;
		typedAt = now;
		const target = typeAheadIndex(
			options().map((o) => o.entry.name),
			typed,
			current,
		);
		if (target >= 0) {
			e.preventDefault();
			els[target]?.focus();
		}
	};

	const unavailableIds = () => [
		...new Set(missing().map((scheme) => state.themeSelection[scheme])),
	];

	return (
		<div
			class="theme-picker"
			classList={{ floating: props.floating }}
			ref={root}
			onFocusOut={(e) => {
				if (open() && !root.contains(e.relatedTarget as Node | null)) close(false);
			}}
		>
			<span class="visually-hidden" id={labelId}>
				{props.label}
			</span>
			<button
				type="button"
				class="theme-picker-trigger"
				id={triggerId}
				ref={trigger}
				aria-haspopup="listbox"
				aria-expanded={open()}
				aria-controls={open() ? listId : undefined}
				aria-labelledby={`${labelId} ${triggerId}`}
				disabled={state.themes === null}
				onClick={() => (open() ? close(false) : openList())}
				onKeyDown={(e) => {
					if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
					e.preventDefault();
					if (!open()) openList();
				}}
			>
				<Show
					when={shownEntry()}
					fallback={
						<span class="theme-picker-value">
							{state.themesError !== null ? "Themes unavailable" : "Loading themes…"}
						</span>
					}
				>
					{(entry) => (
						<>
							<span class="theme-swatches" aria-hidden="true">
								<For each={shownSchemes()}>
									{(scheme) => <Swatch id={entry().id} scheme={scheme} />}
								</For>
							</span>
							<span class="theme-picker-value">
								<Show when={missing().length === 0} fallback={<>{unavailableIds().join(", ")}</>}>
									{entry().name}
								</Show>
							</span>
							<Show when={missing().length > 0}>
								<span class="theme-picker-flag">unavailable</span>
							</Show>
						</>
					)}
				</Show>
				<ChevronDownIcon class="theme-picker-chevron" />
			</button>
			<Show when={missing().length > 0}>
				<p class="theme-picker-notice" role="status">
					Selected theme unavailable: {unavailableIds().join(", ")}. Showing the default theme; the
					choice is kept.
				</p>
			</Show>
			<Show when={open()}>
				<div
					class="theme-picker-list"
					role="listbox"
					id={listId}
					ref={list}
					data-inline-escape
					aria-labelledby={labelId}
					on:keydown={onListKeyDown}
				>
					<For each={options()}>
						{(option, index) => {
							const selected = () => option.entry.id === selectedId();
							const rowId = () => `${listId}-${index()}`;
							const rowScheme = (): ThemeScheme | null =>
								selected() && option.schemes.includes(inUseScheme()) ? inUseScheme() : null;
							return (
								<div
									class="theme-option"
									classList={{ selected: selected() }}
									role="option"
									aria-selected={selected()}
									aria-labelledby={`${rowId()}-name`}
									aria-describedby={`${rowId()}-desc`}
									tabindex={index() === tabStop() ? 0 : -1}
									onFocus={() => setActive(index())}
									onClick={() => choose(index())}
								>
									<span class="visually-hidden" id={`${rowId()}-name`}>
										{option.entry.name}
									</span>
									<span class="visually-hidden" id={`${rowId()}-desc`}>
										{optionDescription(option, rowScheme())}
									</span>
									<span class="theme-option-halves" aria-hidden="true">
										<For each={option.schemes}>
											{(scheme, half) => (
												<OptionHalf
													entry={option.entry}
													scheme={scheme}
													showModified={half() === 0}
												/>
											)}
										</For>
									</span>
									<span class="theme-option-check" aria-hidden="true">
										<Show when={selected()}>
											<CheckIcon />
										</Show>
									</span>
								</div>
							);
						}}
					</For>
				</div>
			</Show>
		</div>
	);
};
