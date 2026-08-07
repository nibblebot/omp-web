import { createSignal, For, onCleanup, onMount, Show, type Component, type JSX } from "solid-js";
import {
	appearanceTuiGroups,
	appearanceWebImages,
	displayOptionValue,
	filterSettings,
	formatItemValue,
	type SettingsMatch,
} from "../settings";
import { call, refreshSettings, setNotifyEnabled, setState, state, updateSetting } from "../state";
import {
	currentFontSize,
	currentThemePreference,
	setTheme,
	stepFontSize,
	THEME_OPTIONS,
	type ThemePreference,
} from "../theme";
import type { SettingsItem } from "../protocol";
import { Modal } from "./Modal";

/**
 * Full-screen settings panel (TUI /settings parity): sidebar navigation with
 * nested subsections on wide screens (horizontal tab bar fallback on narrow),
 * per-type controls and global type-to-search. Client sections are a "Web UI"
 * section (client-local toggles + web-relevant image handling), one entry per
 * non-appearance schema tab, and a "TUI" section holding the terminal-only
 * appearance groups. Server calls go through refreshSettings / updateSetting;
 * the returned model is authoritative and settings_changed frames keep this
 * panel (and every other tab) in sync.
 */
export const SettingsPanel: Component<{ onClose: () => void }> = props => {
	const [query, setQuery] = createSignal("");
	const [activeTab, setActiveTab] = createSignal<string | null>(null);
	// Sidebar group filter: a subsection pick scopes the body to one group.
	const [activeGroup, setActiveGroup] = createSignal<string | null>(null);
	// Wide layout detection: sidebar navigation + group filtering only apply
	// on wide terminals; narrow keeps the flat tab bar and unfiltered body.
	const [wide, setWide] = createSignal(window.matchMedia("(min-width: 721px)").matches);
	const [theme, setThemeSignal] = createSignal<ThemePreference>(currentThemePreference());
	const [fontSize, setFontSize] = createSignal(currentFontSize());

	onMount(() => refreshSettings());
	onMount(() => {
		const mql = window.matchMedia("(min-width: 721px)");
		const onChange = (e: MediaQueryListEvent) => setWide(e.matches);
		mql.addEventListener("change", onChange);
		onCleanup(() => mql.removeEventListener("change", onChange));
	});

	const model = () => state.settingsModel;
	// Client tabs: "Web UI" first, then one tab per non-appearance schema tab
	// (schema order), then "TUI" for the terminal-only appearance groups. The
	// tab bar only renders once a model exists; with no model it's just
	// "Web UI".
	const clientTabs = () => {
		const tabs = [{ id: "web-ui", label: "Web UI" }];
		const m = model();
		if (m) {
			for (const tab of m.tabs) {
				if (tab.id !== "appearance") tabs.push({ id: tab.id, label: tab.label });
			}
			tabs.push({ id: "tui", label: "TUI" });
		}
		return tabs;
	};
	// Keep the pick valid across model refreshes; an unknown or stale id falls
	// back to "web-ui" (the tab bar only renders under a loaded model, so a
	// stale pick is harmless).
	const activeTabId = () => {
		const picked = activeTab();
		if (picked && clientTabs().some(t => t.id === picked)) return picked;
		return "web-ui";
	};
	// The schema tab backing a client tab id; null for client-local tabs.
	const schemaTab = (id: string) => model()?.tabs.find(t => t.id === id) ?? null;
	// Sidebar subsection names for a client tab, in display order; empty group
	// names are skipped (the TUI/group rendering only shows h3s for named groups).
	const tabSubsections = (id: string): string[] => {
		if (id === "web-ui") return ["Interface", "Images"];
		const m = model();
		if (id === "tui") return m ? appearanceTuiGroups(m).map(g => g.name).filter(Boolean) : [];
		const tab = schemaTab(id);
		return tab ? tab.groups.map(g => g.name).filter(Boolean) : [];
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
	// Flat matches grouped by CLIENT tab label: appearance-tab matches show
	// under "TUI", the rest under their schema tab's label.
	const resultsByTab = () => {
		const tabs = clientTabs();
		const byLabel = new Map<string, SettingsMatch[]>();
		for (const match of results()) {
			const clientId = match.tab.id === "appearance" ? "tui" : match.tab.id;
			const label = tabs.find(t => t.id === clientId)?.label ?? clientId;
			const list = byLabel.get(label) ?? [];
			list.push(match);
			byLabel.set(label, list);
		}
		return [...byLabel.entries()];
	};

	return (
		<Modal variant="sheet" class="settings-panel" onClose={props.onClose}>
			<div class="settings-header">
				<h2 class="settings-title">Settings</h2>
				<input
					class="settings-search"
					type="text"
					placeholder="Search settings…"
					value={query()}
					onInput={e => setQuery(e.currentTarget.value)}
				/>
				<button type="button" class="settings-close" aria-label="Close settings" onClick={props.onClose}>
					×
				</button>
			</div>
			<Show when={model()}>
				<div class="settings-tabs" role="tablist">
					<For each={clientTabs()}>
						{tab => (
							<button
								type="button"
								class="settings-tab" classList={{ active: tab.id === activeTabId() }}
								role="tab"
								aria-selected={tab.id === activeTabId()}
								onClick={() => selectTab(tab.id)}
							>
								{tab.label}
							</button>
						)}
					</For>
				</div>
			</Show>
			<div class="settings-content">
				<Show when={model()}>
					<nav class="settings-nav" aria-label="Settings sections">
						<For each={clientTabs()}>
							{tab => (
								<>
									<button
										type="button"
										class="settings-section" classList={{ active: tab.id === activeTabId() }}
										aria-current={tab.id === activeTabId() ? "true" : undefined}
										onClick={() => selectTab(tab.id)}
									>
										{tab.label}
									</button>
									<Show when={tab.id === activeTabId()}>
										<For each={tabSubsections(tab.id)}>
											{name => (
												<button
													type="button"
													class="settings-subsection" classList={{ active: activeGroup() === name }}
													onClick={() => {
														setActiveGroup(name);
														setQuery("");
													}}
												>
													{name}
												</button>
											)}
										</For>
									</Show>
								</>
							)}
						</For>
					</nav>
				</Show>
				<div class="settings-body">
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
									<For each={matches}>{match => <SettingsRow item={match.item} />}</For>
								</div>
							)}
						</For>
					</Show>
					<Show when={!searching() && model()}>
						<Show when={activeTabId() === "web-ui" && (visibleGroup() === null || visibleGroup() === "Interface")}>
							<div class="settings-group">
								<h3 class="settings-group-title">Interface</h3>
								<Row label="theme preference">
									<select
										value={theme()}
										onChange={e => setThemeSignal(setTheme(e.currentTarget.value as ThemePreference))}
									>
										<For each={THEME_OPTIONS}>
											{o => <option value={o.id}>{o.label}</option>}
										</For>
									</select>
								</Row>
								<Row label="font size">
									<div class="settings-font">
										<button type="button" class="settings-control-btn" onClick={() => setFontSize(stepFontSize(-1))}>
											−
										</button>
										<span class="settings-font-value">{fontSize()}</span>
										<button type="button" class="settings-control-btn" onClick={() => setFontSize(stepFontSize(1))}>
											+
										</button>
									</div>
								</Row>
								<Row label="desktop notifications">
									<input
										type="checkbox"
										checked={state.notifyEnabled}
										onChange={e => setNotifyEnabled(e.currentTarget.checked)}
									/>
								</Row>
								<Row label="reveal queue">
									<input
										type="checkbox"
										checked={state.reveal}
										onChange={e => setState("reveal", e.currentTarget.checked)}
									/>
								</Row>
								<Row label="soft fade">
									<input
										type="checkbox"
										checked={state.soften}
										onChange={e => setState("soften", e.currentTarget.checked)}
									/>
								</Row>
								<Row label="fast mode">
									<input
										type="checkbox"
										checked={state.fastModeEnabled}
										onChange={e =>
											void call("setFastMode", [e.currentTarget.checked]).catch(err => setState("error", String(err)))
										}
									/>
								</Row>
								<Row label="auto-retry">
									<input
										type="checkbox"
										checked={state.autoRetryEnabled}
										onChange={e =>
											void call("setAutoRetry", [e.currentTarget.checked]).catch(err => setState("error", String(err)))
										}
									/>
								</Row>
								<Row label="Login providers…">
									<button type="button" class="settings-control-btn" onClick={() => setState("modal", "login")}>
										manage
									</button>
								</Row>
							</div>
						</Show>
						<Show when={activeTabId() === "web-ui" && (visibleGroup() === null || visibleGroup() === "Images") && appearanceWebImages(model()!).length > 0}>
							<div class="settings-group">
								<h3 class="settings-group-title">Images</h3>
								<For each={appearanceWebImages(model()!)}>{item => <SettingsRow item={item} />}</For>
							</div>
						</Show>
						<Show when={schemaTab(activeTabId())} keyed>
							{tab => (
								<>
									<h3 class="settings-group-title">{tab.label}</h3>
									<For each={tab.groups.filter(g => visibleGroup() === null || g.name === visibleGroup())}>
										{group => (
											<div class="settings-group">
												<Show when={group.name}>
													<h3 class="settings-group-title">{group.name}</h3>
												</Show>
												<For each={group.items}>{item => <SettingsRow item={item} />}</For>
											</div>
										)}
									</For>
								</>
							)}
						</Show>
						<Show when={activeTabId() === "tui"}>
							<For each={appearanceTuiGroups(model()!).filter(g => visibleGroup() === null || g.name === visibleGroup())}>
								{group => (
									<div class="settings-group">
										<Show when={group.name}>
											<h3 class="settings-group-title">{group.name}</h3>
										</Show>
										<For each={group.items}>{item => <SettingsRow item={item} />}</For>
									</div>
								)}
							</For>
						</Show>
					</Show>
				</div>
			</div>
		</Modal>
	);
};

/** Shared row layout: label (+ changed dot) and description left, control right. */
function Row(props: { label: string; description?: string; changed?: boolean; children: JSX.Element }) {
	return (
		<div class="settings-item">
			<div>
				<div class="settings-item-label">
					{props.label}
					<Show when={props.changed}>
						<span class="changed-dot" />
					</Show>
				</div>
				<Show when={props.description}>
					<div class="settings-item-desc">{props.description}</div>
				</Show>
			</div>
			<div class="settings-item-control">{props.children}</div>
		</div>
	);
}

/** One server-model row; widget depends on item.type. */
function SettingsRow(props: { item: SettingsItem }) {
	const item = props.item;
	// Text draft: local until Enter/blur commits it (placeholder shows the
	// current value; the draft starts empty so a no-op blur sends nothing).
	const [draft, setDraft] = createSignal("");
	const [dirty, setDirty] = createSignal(false);
	const [showSecret, setShowSecret] = createSignal(false);
	// providerLimits: expanded panel with per-provider drafts, reseeded on open.
	const [limitsOpen, setLimitsOpen] = createSignal(false);
	const [limitDrafts, setLimitDrafts] = createSignal<Record<string, string>>({});

	const commitText = () => {
		if (!dirty()) return;
		updateSetting(item.path, draft());
		setDraft("");
		setDirty(false);
	};

	const seedLimitDrafts = () => {
		const record = (item.value && typeof item.value === "object" ? item.value : {}) as Record<string, number>;
		const seeded: Record<string, string> = {};
		for (const provider of item.providers ?? []) {
			seeded[provider] = record[provider] !== undefined ? String(record[provider]) : "";
		}
		setLimitDrafts(seeded);
	};

	const commitLimit = (provider: string, raw: string) => {
		const next = { ...limitDrafts(), [provider]: raw };
		setLimitDrafts(next);
		// Empty input = unlimited: only finite positive numbers make it through.
		const out: Record<string, number> = {};
		for (const p of item.providers ?? []) {
			const text = next[p];
			if (text === undefined || text === "") continue;
			const n = Number(text);
			if (Number.isFinite(n) && n > 0) out[p] = n;
		}
		updateSetting(item.path, out);
	};

	const resetLimits = () => {
		setLimitDrafts(Object.fromEntries((item.providers ?? []).map(p => [p, ""])));
		updateSetting(item.path, {});
	};

	const selected = () => (Array.isArray(item.value) ? (item.value as string[]) : []);
	const chipOptions = () =>
		item.options ?? (item.values ?? []).map(v => ({ value: v, label: v, description: undefined }));
	const toggleOption = (value: string) => {
		const cur = selected();
		const next = cur.includes(value) ? cur.filter(v => v !== value) : [...cur, value];
		updateSetting(item.path, next);
	};
	const moveOption = (value: string, dir: -1 | 1) => {
		const cur = [...selected()];
		const i = cur.indexOf(value);
		if (i < 0) return;
		const j = i + dir;
		if (j < 0 || j >= cur.length) return;
		[cur[i], cur[j]] = [cur[j], cur[i]];
		updateSetting(item.path, cur);
	};

	let control: JSX.Element;
	switch (item.type) {
		case "boolean":
			control = (
				<input
					type="checkbox"
					checked={Boolean(item.value)}
					onChange={e => updateSetting(item.path, e.currentTarget.checked)}
				/>
			);
			break;
		case "enum":
			control = (
				<select
					value={displayOptionValue(item, item.value)}
					onChange={e => updateSetting(item.path, e.currentTarget.value)}
				>
					<For each={item.values ?? []}>{v => <option value={v}>{v}</option>}</For>
				</select>
			);
			break;
		case "submenu":
			control = (
				<select
					value={displayOptionValue(item, item.value)}
					onChange={e => updateSetting(item.path, e.currentTarget.value)}
				>
					<For each={item.options ?? []}>
						{opt => (
							<option value={opt.value} title={opt.description}>
								{opt.label}
							</option>
						)}
					</For>
				</select>
			);
			break;
		case "text":
			control = (
				<div class="settings-text">
					<input
						type={item.secret && !showSecret() ? "password" : "text"}
						value={draft()}
						placeholder={formatItemValue(item)}
						onInput={e => {
							setDraft(e.currentTarget.value);
							setDirty(true);
						}}
						onBlur={commitText}
						onKeyDown={e => {
							if (e.key === "Enter") e.currentTarget.blur();
						}}
					/>
					<Show when={item.secret}>
						<button
							type="button"
							class="settings-control-btn"
							onClick={() => setShowSecret(v => !v)}
						>
							{showSecret() ? "hide" : "show"}
						</button>
					</Show>
				</div>
			);
			break;
		case "multiselect":
			control = (
				<div class="settings-chips">
					<For each={chipOptions()}>
						{opt => {
							const on = selected().includes(opt.value);
							return (
								<span class="settings-chip-wrap">
									<button
										type="button"
										class="settings-chip"
										aria-pressed={on}
										onClick={() => toggleOption(opt.value)}
									>
										{opt.label}
									</button>
									<Show when={item.ordered && on}>
										<button
											type="button"
											class="settings-chip-move"
											aria-label="Move up"
											onClick={e => {
												e.stopPropagation();
												moveOption(opt.value, -1);
											}}
										>
											▲
										</button>
										<button
											type="button"
											class="settings-chip-move"
											aria-label="Move down"
											onClick={e => {
												e.stopPropagation();
												moveOption(opt.value, 1);
											}}
										>
											▼
										</button>
									</Show>
								</span>
							);
						}}
					</For>
				</div>
			);
			break;
		case "providerLimits":
			control = (
				<button
					type="button"
					class="settings-control-btn"
					onClick={() => {
						seedLimitDrafts();
						setLimitsOpen(v => !v);
					}}
				>
					{limitsOpen() ? "hide limits" : "set limits"}
				</button>
			);
			break;
		default:
			control = <span class="settings-item-desc">{formatItemValue(item)}</span>;
	}

	return (
		<>
			<Row label={item.label} description={item.description} changed={item.changed}>
				{control}
			</Row>
			<Show when={item.type === "providerLimits" && limitsOpen()}>
				<div class="settings-limit-inputs">
					<For each={item.providers ?? []}>
						{provider => (
							<label class="settings-limit-field">
								{provider}
								<input
									type="number"
									min={0}
									value={limitDrafts()[provider] ?? ""}
									onInput={e => commitLimit(provider, e.currentTarget.value)}
								/>
							</label>
						)}
					</For>
					<button type="button" class="settings-control-btn" onClick={resetLimits}>
						reset
					</button>
				</div>
			</Show>
		</>
	);
}
