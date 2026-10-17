import { createMemo, createSignal, Index, onMount, Show, type Component } from "solid-js";
import { filterSettings, filterWebUiSettings, type SettingsMatch } from "../../prefs/settings";
import {
	changedCountsByTab,
	DEFAULT_SETTINGS_TAB_ID,
	settingsSectionId,
	settingsTabMeta,
	visibleSettingsTabs,
	type SettingsTabMeta,
} from "../../prefs/settings-tabs";
import { authSnapshot } from "../../store/auth";
import { consumeSettingsTab } from "../../store/models";
import { fleetSettingsActive, refreshSettings, setState, state } from "../../state";
import { SearchIcon } from "../ui/icons";
import { Modal } from "../ui/Modal";
import { CommonSettings } from "./CommonSettings";
import { FeaturesSettings, searchFeatures } from "./FeaturesSettings";
import { InstalledTab } from "./InstalledTab";
import { ModelRoleTable } from "./ModelRoleTable";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsNav, SettingsSectionPicker, type SettingsSection } from "./SettingsNav";
import { SettingsRow, SettingsRowLayout } from "./SettingsRow";
import { WebUiSettings } from "./WebUiSettings";

/**
 * Full-screen settings panel (TUI /settings parity): a header with search, a
 * vertical tab sidebar on wide screens (a section picker on narrow), and one
 * stacked body per tab. Tabs are Common (daily rows), the SDK tabs (server model),
 * Installed, Web UI and Features (client-local). Search spans every tab and groups matches
 * by tab and section. Server calls go through refreshSettings / updateSetting;
 * the returned model is authoritative and settings_changed frames keep this
 * panel (and every other tab) in sync.
 */
export const SettingsSheet: Component<{ onClose: () => void }> = (props) => {
	// `/settings <query>` opens with the search pre-filled (state.settingsQuery).
	const [query, setQuery] = createSignal(state.settingsQuery);
	const [activeTab, setActiveTab] = createSignal(state.settingsTab ?? DEFAULT_SETTINGS_TAB_ID);
	let bodyRef: HTMLDivElement | undefined;

	onMount(() => {
		// A deep link (Alt+M, /model) names the tab to open; consume it once.
		const tab = consumeSettingsTab();
		if (tab && settingsTabMeta(tab)) setActiveTab(tab);
		void refreshSettings();
	});

	const model = () => state.settingsModel;
	const tabs = () => visibleSettingsTabs(model());
	const changedCounts = createMemo(() => changedCountsByTab(model()));
	// A pick that is no longer visible (for example a model refresh dropped
	// it) falls back to the default tab.
	const activeTabId = () => {
		const picked = activeTab();
		return tabs().some((t) => t.id === picked) ? picked : DEFAULT_SETTINGS_TAB_ID;
	};
	const active = () => settingsTabMeta(activeTabId());
	// The SDK model tab backing an id; null for client-local tabs.
	const schemaTab = (id: string) => model()?.tabs.find((t) => t.id === id) ?? null;
	// Sidebar sections listed under the active tab: named SDK groups, and for
	// Web UI the Interface section plus Session while signed in.
	const sectionsOf = (tab: SettingsTabMeta): SettingsSection[] => {
		if (tab.kind === "sdk") {
			const groups = schemaTab(tab.id)?.groups ?? [];
			return groups
				.filter((g) => g.name)
				.map((g) => ({ id: settingsSectionId(tab.id, g.name), label: g.name }));
		}
		if (tab.id === "web-ui") {
			const signedIn = authSnapshot().status === "signedIn";
			return [
				{ id: settingsSectionId("web-ui", "Interface"), label: "Interface" },
				...(signedIn ? [{ id: settingsSectionId("web-ui", "Session"), label: "Session" }] : []),
			];
		}
		return [];
	};
	const sections = () => {
		const tab = active();
		return tab ? sectionsOf(tab) : [];
	};
	// Navigation (sidebar and narrow picker): switching tabs clears any
	// in-flight search and returns the body to the top.
	const selectTab = (id: string) => {
		setActiveTab(id);
		setQuery("");
		bodyRef?.scrollTo({ top: 0 });
	};
	// Sidebar section pick: clear the search so the stacked body is shown,
	// then bring the section into view.
	const selectSection = (id: string) => {
		setQuery("");
		document.getElementById(id)?.scrollIntoView({ block: "start" });
	};
	const searching = () => query().trim() !== "";
	const results = () => {
		const m = model();
		return m && searching() ? filterSettings(m, query()) : [];
	};
	const webHits = () =>
		searching()
			? filterWebUiSettings(query(), {
					sessionAttached: !fleetSettingsActive(),
					signedIn: authSnapshot().status === "signedIn",
				})
			: [];
	const featureHits = () => (searching() ? searchFeatures(query()) : []);
	const noMatches = () =>
		searching() &&
		model() !== null &&
		results().length === 0 &&
		webHits().length === 0 &&
		featureHits().length === 0;
	// While searching, the sidebar highlights the tab that holds the first hit.
	const navTabId = () => {
		if (!searching()) return activeTabId();
		const sdkHit = results()[0]?.tab.id;
		if (sdkHit) return sdkHit;
		if (webHits().length > 0) return "web-ui";
		if (featureHits().length > 0) return "features";
		return activeTabId();
	};
	// Matches grouped by tab, then by section. filterSettings returns matches
	// in tab order, so Map insertion order keeps the tab grouping.
	const resultGroups = () => {
		const byTitle = new Map<string, SettingsMatch[]>();
		for (const match of results()) {
			const title = `${match.tab.label} · ${match.group.name}`;
			const list = byTitle.get(title) ?? [];
			list.push(match);
			byTitle.set(title, list);
		}
		return [...byTitle.entries()];
	};

	return (
		<Modal
			variant="sheet"
			class="settings-sheet"
			ariaLabel="Settings"
			onClose={props.onClose}
			header={
				<>
					<span class="settings-mark" aria-hidden="true">
						π
					</span>
					<h2 class="settings-title">omp settings</h2>
					<div class="settings-search-field">
						<SearchIcon class="settings-search-icon" />
						<input
							class="settings-search"
							type="text"
							aria-label="Search settings"
							placeholder="Search settings…"
							value={query()}
							onInput={(e) => setQuery(e.currentTarget.value)}
						/>
					</div>
				</>
			}
		>
			{/* Narrow-layout navigation (CSS-gated below 768px): a section
			    picker instead of the wide layout's sidebar. */}
			<SettingsSectionPicker
				tabs={tabs()}
				activeTabId={activeTabId()}
				sections={sections()}
				onSelectTab={selectTab}
				onSelectSection={selectSection}
			/>
			<div class="settings-content">
				<SettingsNav
					tabs={tabs()}
					activeTabId={navTabId()}
					changedCounts={changedCounts()}
					sections={sections()}
					onSelectTab={selectTab}
					onSelectSection={selectSection}
				/>
				<div class="settings-body" ref={bodyRef}>
					<Show when={searching()}>
						<FeaturesSettings query={query()} />
						<Show when={model()}>
							<Index each={resultGroups()}>
								{(group) => (
									<SettingsGroup title={group()[0]}>
										<Index each={group()[1]}>
											{(match) => <SettingsRow item={match().item} />}
										</Index>
									</SettingsGroup>
								)}
							</Index>
						</Show>
						<Show when={webHits().length > 0}>
							<SettingsGroup title="Web UI">
								<Index each={webHits()}>
									{(label) => (
										<SettingsRowLayout label={label()}>
											<button
												type="button"
												class="settings-control-btn"
												onClick={() => selectTab("web-ui")}
											>
												open
											</button>
										</SettingsRowLayout>
									)}
								</Index>
							</SettingsGroup>
						</Show>
						<Show when={noMatches()}>
							<div class="settings-note">
								No settings match "{query().trim()}".{" "}
								<button type="button" class="settings-control-btn" onClick={() => setQuery("")}>
									clear search
								</button>
							</div>
						</Show>
					</Show>
					<Show when={!searching() && active()} keyed>
						{(tab) => (
							<>
								<header class="settings-hero">
									<h1 class="settings-hero-title">{tab.label}</h1>
									<p class="settings-lead">{tab.lead}</p>
								</header>
								<Show when={tab.id === "features"}>
									<FeaturesSettings />
								</Show>
								<Show when={tab.id === "installed"}>
									<InstalledTab />
								</Show>
								<Show when={tab.id === "web-ui"}>
									<WebUiSettings />
								</Show>
								<Show when={tab.id === "model"}>
									<ModelRoleTable />
								</Show>
								<Show when={tab.kind === "common"}>
									<CommonSettings />
								</Show>
								<Show when={tab.kind === "sdk"}>
									<Show
										when={schemaTab(tab.id)}
										fallback={
											<div class="settings-note">
												{state.settingsLoading ? "Loading settings…" : "Settings unavailable."}
											</div>
										}
									>
										{(schema) => (
											<Index each={schema().groups}>
												{(group) => (
													<SettingsGroup
														title={group().name}
														id={settingsSectionId(tab.id, group().name)}
													>
														<Index each={group().items}>
															{(item) => <SettingsRow item={item()} />}
														</Index>
													</SettingsGroup>
												)}
											</Index>
										)}
									</Show>
								</Show>
							</>
						)}
					</Show>
				</div>
			</div>
		</Modal>
	);
};
