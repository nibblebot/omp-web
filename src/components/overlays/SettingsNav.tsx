import { For, Show } from "solid-js";
import { fleetSettingsActive } from "../../state";

/** A settings section in the panel navigation: id + display label. */
export interface SettingsSection {
	id: string;
	label: string;
}

/**
 * Narrow-layout navigation (CSS-gated to ≤720px): a section picker select
 * instead of the wide rail. Pure view — the shell owns the selected-tab
 * state and passes it down with the change callback.
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
 * Wide-layout navigation rail (CSS-gated to ≥721px): one button per section,
 * the active section's subsections beneath it, and the fleet fallback
 * footnote pinned to the rail bottom. Pure view — the shell owns selection
 * state and passes callbacks down.
 */
export function SettingsNav(props: {
	sections: SettingsSection[];
	activeTabId: string;
	subsections: string[];
	activeGroup: string | null;
	onSelectTab: (id: string) => void;
	onSelectGroup: (name: string) => void;
}) {
	return (
		<nav class="settings-nav" aria-label="Settings sections">
			<For each={props.sections}>
				{(tab) => (
					<>
						<button
							type="button"
							class="settings-section"
							classList={{ active: tab.id === props.activeTabId }}
							aria-current={tab.id === props.activeTabId ? "true" : undefined}
							onClick={() => props.onSelectTab(tab.id)}
						>
							{tab.label}
						</button>
						<Show when={tab.id === props.activeTabId}>
							<For each={props.subsections}>
								{(name) => (
									<button
										type="button"
										class="settings-subsection"
										classList={{ active: props.activeGroup === name }}
										onClick={() => props.onSelectGroup(name)}
									>
										{name}
									</button>
								)}
							</For>
						</Show>
					</>
				)}
			</For>
			{/* Fleet fallback notice: a quiet footnote pinned to the bottom of
			    the nav rail, not body chrome. */}
			<Show when={fleetSettingsActive()}>
				<div class="settings-nav-footnote">
					No session attached — changes save to config.yml and apply to new sessions.
				</div>
			</Show>
		</nav>
	);
}
