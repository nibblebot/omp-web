import { createEffect, For, on, Show, type Component } from "solid-js";
import { fleetSettingsActive } from "../../state";
import {
	tabBadgeCount,
	type SettingsTabIconName,
	type SettingsTabMeta,
} from "../../prefs/settings-tabs";
import {
	DatabaseIcon,
	FileIcon,
	FlaskIcon,
	KeyboardIcon,
	LayersIcon,
	ListIcon,
	MonitorIcon,
	CrosshairIcon,
	PackageIcon,
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
	package: PackageIcon,
	monitor: MonitorIcon,
	flask: FlaskIcon,
};

/**
 * Narrow-layout navigation (CSS-gated below 768px): a section picker select
 * instead of the wide sidebar. It is a pure view; the shell owns the
 * selected-tab state and passes it down with the change callback.
 */
export function SettingsSectionPicker(props: {
	sections: SettingsSection[];
	activeTabId: string;
	onSelectTab: (id: string) => void;
}) {
	return (
		<nav class="settings-section-picker" aria-label="Settings sections">
			<select
				aria-label="Settings section"
				value={props.activeTabId}
				onChange={(e) => props.onSelectTab(e.currentTarget.value)}
			>
				<For each={props.sections}>{(tab) => <option value={tab.id}>{tab.label}</option>}</For>
			</select>
		</nav>
	);
}

/**
 * Wide-layout sidebar (CSS-gated to ≥721px): one row per tab (icon, label,
 * purple changed-count for SDK tabs), a rule between the SDK, Installed and
 * client groups, the active tab's sections beneath it, and the fleet
 * fallback footnote pinned to the bottom. It is a pure view; the shell owns
 * selection state and passes callbacks down.
 */
export function SettingsNav(props: {
	tabs: SettingsTabMeta[];
	activeTabId: string;
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
			<For each={props.tabs}>
				{(tab, index) => {
					const Icon = TAB_ICONS[tab.icon];
					const badge = () => tabBadgeCount(props.changedCounts, tab);
					return (
						<>
							<Show when={index() > 0 && props.tabs[index() - 1].kind !== tab.kind}>
								<hr class="settings-nav-divider" />
							</Show>
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
			{/* Fleet fallback notice: a quiet footnote pinned to the bottom of
			    the nav, not body chrome. */}
			<Show when={fleetSettingsActive()}>
				<div class="settings-nav-footnote">
					No session attached. Changes save to config.yml and apply to new sessions.
				</div>
			</Show>
		</nav>
	);
}
