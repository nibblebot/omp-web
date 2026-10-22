import { createEffect, For, on, Show, type Component } from "solid-js";
import {
	settingsTabRuns,
	tabBadgeCount,
	type SettingsTabIconName,
	type SettingsTabMeta,
} from "../../prefs/settings-tabs";
import {
	BotIcon,
	DatabaseIcon,
	FileIcon,
	FlaskIcon,
	KeyboardIcon,
	LayersIcon,
	ListIcon,
	MonitorIcon,
	CrosshairIcon,
	PencilIcon,
	ServerIcon,
	TerminalIcon,
	WandIcon,
	type IconProps,
} from "../ui/icons";
import { moveRovingFocus, setRovingTabStop } from "../ui/roving";

/** A section listed under the active tab: DOM id to scroll to + display label. */
export interface SettingsSection {
	id: string;
	label: string;
}

const TAB_ICONS: Record<SettingsTabIconName, Component<IconProps>> = {
	pencil: PencilIcon,
	crosshair: CrosshairIcon,
	keyboard: KeyboardIcon,
	layers: LayersIcon,
	memory: DatabaseIcon,
	files: FileIcon,
	terminal: TerminalIcon,
	wand: WandIcon,
	list: ListIcon,
	server: ServerIcon,
	monitor: MonitorIcon,
	flask: FlaskIcon,
	bot: BotIcon,
};

/**
 * Narrow-layout navigation (CSS-gated below 768px): a tab select and, beneath
 * it, a section select for the current tab, instead of the wide layout's
 * sidebar. Both selects follow the stream's scroll position and jump within it,
 * so a long tab such as Model stays reachable without scrolling thousands of
 * pixels. It is a pure view; the shell owns the position and passes it down
 * with the callbacks.
 */
export function SettingsSectionPicker(props: {
	tabs: SettingsTabMeta[];
	activeTabId: string;
	/** The section the stream is scrolled to; none before the first section heading. */
	activeSectionId?: string | null;
	sections: SettingsSection[];
	onSelectTab: (id: string) => void;
	onSelectSection: (id: string) => void;
}) {
	return (
		<nav class="settings-section-picker" aria-label="Settings sections">
			<select aria-label="Settings tab" onChange={(e) => props.onSelectTab(e.currentTarget.value)}>
				<For each={props.tabs}>
					{(tab) => (
						<option value={tab.id} selected={tab.id === props.activeTabId}>
							{tab.label}
						</option>
					)}
				</For>
			</select>
			<Show when={props.sections.length > 0}>
				<select
					aria-label="Settings section"
					onChange={(e) => props.onSelectSection(e.currentTarget.value)}
				>
					<option value="" disabled selected={!props.activeSectionId}>
						Jump to section
					</option>
					<For each={props.sections}>
						{(s) => (
							<option value={s.id} selected={s.id === props.activeSectionId}>
								{s.label}
							</option>
						)}
					</For>
				</select>
			</Show>
		</nav>
	);
}

/**
 * Wide-layout sidebar (CSS-gated to ≥721px): the tabs of the stream, one row
 * each (icon, label, purple changed-count for SDK tabs), under lowercase `omp`
 * and `omp-web` section labels (none above the session tab), with the current
 * tab's sections beneath it. Both levels carry aria-current and follow the
 * stream's scroll position. It is a pure view; the shell owns the position and
 * passes callbacks down.
 */
export function SettingsNav(props: {
	tabs: SettingsTabMeta[];
	activeTabId: string;
	/** The section the stream is scrolled to; none before the first section heading. */
	activeSectionId?: string | null;
	changedCounts: Map<string, number>;
	sections: SettingsSection[];
	onSelectTab: (id: string) => void;
	onSelectSection: (id: string) => void;
}) {
	let nav!: HTMLElement;
	const navItems = () =>
		Array.from(nav.querySelectorAll<HTMLElement>(".settings-section, .settings-subsection"));
	// One tab stop for the whole nav (the active tab); arrows, Home and End move.
	createEffect(
		on([() => props.activeTabId, () => props.sections], () =>
			queueMicrotask(() => {
				const items = navItems();
				const active = items.findIndex((el) => el.getAttribute("aria-current") === "true");
				setRovingTabStop(items, Math.max(0, active));
			}),
		),
	);
	const onNavKeyDown = (e: KeyboardEvent) => {
		const items = navItems();
		moveRovingFocus(e, items, items.indexOf(e.target as HTMLElement), "vertical");
	};
	const onNavFocusIn = (e: FocusEvent) => {
		const items = navItems();
		const index = items.indexOf(e.target as HTMLElement);
		if (index >= 0) setRovingTabStop(items, index);
	};
	return (
		<nav
			ref={nav}
			class="settings-nav"
			aria-label="Settings sections"
			onKeyDown={onNavKeyDown}
			onFocusIn={onNavFocusIn}
		>
			<For each={settingsTabRuns(props.tabs)}>
				{(run) => (
					<>
						<Show when={run.section !== "session"}>
							<div class="settings-nav-heading">{run.section}</div>
						</Show>
						<For each={run.tabs}>
							{(tab) => {
								const Icon = TAB_ICONS[tab.icon];
								const badge = () => tabBadgeCount(props.changedCounts, tab);
								return (
									<>
										<button
											type="button"
											class="settings-section"
											classList={{ active: tab.id === props.activeTabId }}
											aria-current={tab.id === props.activeTabId ? "true" : undefined}
											onClick={() => props.onSelectTab(tab.id)}
										>
											<Icon class="settings-nav-icon" />
											<span class="settings-nav-label">{tab.label}</span>
											<Show when={badge() > 0}>
												<span class="settings-nav-badge">{badge()}</span>
											</Show>
										</button>
										<Show when={tab.id === props.activeTabId}>
											<For each={props.sections}>
												{(section) => (
													<button
														type="button"
														class="settings-subsection"
														aria-current={section.id === props.activeSectionId ? "true" : undefined}
														onClick={() => props.onSelectSection(section.id)}
													>
														{section.label}
													</button>
												)}
											</For>
										</Show>
									</>
								);
							}}
						</For>
					</>
				)}
			</For>
		</nav>
	);
}
