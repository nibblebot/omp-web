import { createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js";
import { filterSettings, type SettingsMatch } from "../../prefs/settings";
import { fleetSettingsActive, refreshSettings, state } from "../../state";
import { XIcon } from "../shared/icons";
import { Modal } from "../shared/Modal";
import { SettingsNav, SettingsSectionPicker } from "./SettingsNav";
import { SettingsRow } from "./SettingsRow";
import { WebUiSettings } from "./WebUiSettings";

/**
 * Full-screen settings panel (TUI /settings parity): sidebar navigation with
 * nested subsections on wide screens (horizontal tab bar fallback on narrow),
 * per-type controls and global type-to-search. Client sections are a "Web UI"
 * section (client-local toggles + web-relevant image handling) and one entry
 * per non-appearance schema tab. Server calls go through refreshSettings / updateSetting;
 * the returned model is authoritative and settings_changed frames keep this
 * panel (and every other tab) in sync.
 */
export const SettingsModal: Component<{ onClose: () => void }> = (props) => {
	const [query, setQuery] = createSignal("");
	const [activeTab, setActiveTab] = createSignal<string | null>(null);
	// Sidebar group filter: a subsection pick scopes the body to one group.
	const [activeGroup, setActiveGroup] = createSignal<string | null>(null);
	// Wide layout detection: sidebar navigation + group filtering only apply
	// on wide terminals; narrow keeps the flat tab bar and unfiltered body.
	const [wide, setWide] = createSignal(window.matchMedia("(min-width: 721px)").matches);

	onMount(() => refreshSettings());
	onMount(() => {
		const mql = window.matchMedia("(min-width: 721px)");
		const onChange = (e: MediaQueryListEvent) => setWide(e.matches);
		mql.addEventListener("change", onChange);
		onCleanup(() => mql.removeEventListener("change", onChange));
	});

	const model = () => state.settingsModel;
	// Client tabs: "Web UI" first, then one tab per non-appearance schema tab
	// (schema order). The tab bar only renders once a model exists; with no
	// model it's just "Web UI".
	const clientTabs = () => {
		const tabs = [{ id: "web-ui", label: "Web UI" }];
		const m = model();
		if (m) {
			for (const tab of m.tabs) {
				if (tab.id !== "appearance") tabs.push({ id: tab.id, label: tab.label });
			}
		}
		return tabs;
	};
	// Keep the pick valid across model refreshes; an unknown or stale id falls
	// back to "web-ui" (the tab bar only renders under a loaded model, so a
	// stale pick is harmless).
	const activeTabId = () => {
		const picked = activeTab();
		if (picked && clientTabs().some((t) => t.id === picked)) return picked;
		return "web-ui";
	};
	// The schema tab backing a client tab id; null for client-local tabs.
	const schemaTab = (id: string) => model()?.tabs.find((t) => t.id === id) ?? null;
	// Sidebar subsection names for a client tab, in display order; empty group
	// names are skipped (the TUI/group rendering only shows h3s for named groups).
	const tabSubsections = (id: string): string[] => {
		if (id === "web-ui") return ["Interface", "Images"];
		const tab = schemaTab(id);
		return tab ? tab.groups.map((g) => g.name).filter(Boolean) : [];
	};
	// The sidebar's active subsection, validated against the ACTIVE tab: a
	// condition-gated group may vanish on model refresh, so an invalid pick
	// falls back to showing all groups rather than a stale empty body.
	const effectiveGroup = () => {
		const picked = activeGroup();
		return picked !== null && tabSubsections(activeTabId()).includes(picked) ? picked : null;
	};
	// Group filtering only applies on the wide layout; narrow always shows
	// every group of the active tab.
	const visibleGroup = () => (wide() ? effectiveGroup() : null);
	// Navigation (sidebar sections and the narrow tab bar): switching sections
	// clears the group filter and any in-flight search.
	const selectTab = (id: string) => {
		setActiveTab(id);
		setActiveGroup(null);
		setQuery("");
	};
	const searching = () => query().trim() !== "";
	const results = () => {
		const m = model();
		return m && searching() ? filterSettings(m, query()) : [];
	};
	// Flat matches grouped by CLIENT tab label: appearance-tab matches are the
	// web Images group and show under "Web UI", the rest under their schema
	// tab's label.
	const resultsByTab = () => {
		const tabs = clientTabs();
		const byLabel = new Map<string, SettingsMatch[]>();
		for (const match of results()) {
			const clientId = match.tab.id === "appearance" ? "web-ui" : match.tab.id;
			const label = tabs.find((t) => t.id === clientId)?.label ?? clientId;
			const list = byLabel.get(label) ?? [];
			list.push(match);
			byLabel.set(label, list);
		}
		return [...byLabel.entries()];
	};

	return (
		<Modal variant="sheet" class="settings-panel" aria-label="Settings" onClose={props.onClose}>
			<div class="settings-header">
				<h2 class="settings-title">Settings</h2>
				<input
					class="settings-search"
					type="text"
					aria-label="Search settings"
					placeholder="Search settings…"
					value={query()}
					onInput={(e) => setQuery(e.currentTarget.value)}
				/>
				<button
					type="button"
					class="settings-close"
					aria-label="Close settings"
					onClick={props.onClose}
				>
					<XIcon />
				</button>
			</div>
			<Show when={model()}>
				{/* Narrow-layout navigation (CSS-gated to ≤720px): a section
				    picker instead of the wide layout's nav rail. */}
				<SettingsSectionPicker
					sections={clientTabs()}
					activeTabId={activeTabId()}
					onSelectTab={selectTab}
				/>
			</Show>
			<div class="settings-content">
				<Show when={model()}>
					<SettingsNav
						sections={clientTabs()}
						activeTabId={activeTabId()}
						subsections={tabSubsections(activeTabId())}
						activeGroup={activeGroup()}
						onSelectTab={selectTab}
						onSelectGroup={(name) => {
							setActiveGroup(name);
							setQuery("");
						}}
					/>
				</Show>
				<div class="settings-body">
					{/* Narrow layout hides the nav rail, so the fleet fallback notice
					    keeps a body copy there only (CSS-gated to ≤720px). */}
					<Show when={fleetSettingsActive()}>
						<div class="settings-note settings-note-narrow">
							No session attached — changes save to config.yml and apply to new sessions.
						</div>
					</Show>
					<Show when={state.settingsLoading && !model()}>
						<div class="settings-note">Loading settings…</div>
					</Show>
					<Show when={!state.settingsLoading && !model()}>
						<div class="settings-note">Settings unavailable.</div>
					</Show>
					<Show when={searching() && model()}>
						<For each={resultsByTab()}>
							{([label, matches]) => (
								<div class="settings-group">
									<h3 class="settings-group-title">{label}</h3>
									<For each={matches}>{(match) => <SettingsRow item={match.item} />}</For>
								</div>
							)}
						</For>
					</Show>
					<Show when={!searching() && model()}>
						<Show when={activeTabId() === "web-ui"}>
							<WebUiSettings model={model()!} visibleGroup={visibleGroup()} />
						</Show>
						<Show when={schemaTab(activeTabId())} keyed>
							{(tab) => (
								<>
									<h3 class="settings-group-title">{tab.label}</h3>
									<For
										each={tab.groups.filter(
											(g) => visibleGroup() === null || g.name === visibleGroup(),
										)}
									>
										{(group) => (
											<div class="settings-group">
												<Show when={group.name}>
													<h3 class="settings-group-title">{group.name}</h3>
												</Show>
												<For each={group.items}>{(item) => <SettingsRow item={item} />}</For>
											</div>
										)}
									</For>
								</>
							)}
						</Show>
					</Show>
				</div>
			</div>
		</Modal>
	);
};
