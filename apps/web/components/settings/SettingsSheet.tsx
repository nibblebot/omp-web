import {
	createEffect,
	createMemo,
	createSignal,
	For,
	Index,
	Match,
	on,
	onCleanup,
	onMount,
	Show,
	Switch,
	untrack,
	type Component,
} from "solid-js";
import type { SettingsTab } from "#lib/wire/protocol";
import { filterSettings, filterWebUiSettings, type SettingsMatch } from "../../prefs/settings";
import {
	changedCountsByTab,
	defaultSettingsTabId,
	scrollSpyIndex,
	settingsSectionId,
	settingsTabHeadingId,
	settingsTabMeta,
	visibleSettingsTabs,
	type SettingsTabMeta,
} from "../../prefs/settings-tabs";
import { searchAutofocus } from "../../store/integrations";
import { consumeSettingsTab } from "../../store/models";
import { fleetSettingsActive, refreshSettings, setState, state } from "../../state";
import { SearchIcon } from "../ui/icons";
import { Modal } from "../ui/Modal";
import { FeaturesSettings, searchFeatures } from "./FeaturesSettings";
import { ModelRoleTable } from "./ModelRoleTable";
import { SessionSettings } from "./SessionSettings";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsNav, SettingsSectionPicker, type SettingsSection } from "./SettingsNav";
import { SettingsRow, SettingsRowLayout } from "./SettingsRow";
import { WebUiSettings } from "./WebUiSettings";

/** A heading becomes current once its top crosses this fraction of the body's height from its top edge. */
const SPY_LINE_FRACTION = 1 / 3;
/** The body counts as scrolled to its top or bottom within this many pixels. */
const EDGE_SLACK_PX = 2;
/** User input that takes the body back from a running nav glide. */
const USER_SCROLL_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/** Section of the Providers tab holding the login row; it follows the SDK groups. */
const LOGIN_SECTION = "Login";

/** Where the stream is scrolled to: the tab, and the section within it once its heading has reached the spy line. */
interface StreamPosition {
	tabId: string | null;
	sectionId: string | null;
}

/** A scroll destination: the heading element to land on, and the position that highlights. */
interface ScrollTarget {
	elementId: string;
	tabId: string;
	sectionId: string | null;
}

/**
 * Full-screen settings panel (TUI /settings parity): a header with search, a
 * vertical sidebar on wide screens (a section picker on narrow), and one
 * continuous scroll stream of every tab body under a small heading each: This
 * Session while a session is attached, then the SDK tabs (`omp`), then
 * Appearance and Features (`omp-web`). Server calls go through
 * refreshSettings / updateSetting; the returned model is authoritative and
 * settings_changed frames keep every tab in sync.
 *
 * Scroll-spy: the active tab is the last heading whose top has crossed the
 * spy line, a third of the way down the scroll body (the top of the stream
 * forces the first tab, the bottom the last), and the active section is the same rule over the
 * active tab's section headings, so the section filling the view is the one
 * highlighted. Nav and picker clicks and deep links glide to a heading over
 * `--dur-move-base` (instantly under reduced motion); the highlight jumps to
 * the target at once and the glide's scroll events are ignored, so it never
 * walks through the tabs in between. The target stays highlighted until the
 * next user scroll, since a heading near the end of the stream may never
 * reach the line.
 *
 * Search spans every tab and replaces the stream with grouped results; the
 * stream stays mounted (hidden), and clearing the search restores its scroll
 * position.
 */
export const SettingsSheet: Component<{ onClose: () => void }> = (props) => {
	// `/settings <query>` opens with the search pre-filled (state.settingsQuery).
	const [query, setQuery] = createSignal(state.settingsQuery);
	const [position, setPosition] = createSignal<StreamPosition>({ tabId: null, sectionId: null });
	let bodyRef!: HTMLDivElement;
	let searchRef!: HTMLInputElement;
	// Stream scrollTop at the moment a search began.
	let savedScroll = 0;
	// The destination of the last programmatic scroll, held until the user scrolls.
	let pending: ScrollTarget | null = null;
	// A deep link that arrived while searching: scrolled to when the search clears.
	let deferred: ScrollTarget | null = null;
	let navigating = false;
	let scrollFrame = 0;
	let spyFrame = 0;
	let mounted = false;

	const model = () => state.settingsModel;
	const sessionAttached = () => !fleetSettingsActive();
	const tabs = createMemo(() => visibleSettingsTabs(model(), sessionAttached()));
	const changedCounts = createMemo(() => changedCountsByTab(model()));
	// The SDK model tab backing an id; null for client-local tabs.
	const schemaTab = (id: string) => model()?.tabs.find((t) => t.id === id) ?? null;
	const signedIn = () => state.authStatus === "signedIn";

	// Sections listed under a tab: named SDK groups (plus the login group on
	// Providers while a session is attached), and for Appearance the
	// Interface group plus Account while signed in.
	const sectionsOf = (tab: SettingsTabMeta): SettingsSection[] => {
		if (tab.kind === "sdk") {
			const named = (schemaTab(tab.id)?.groups ?? [])
				.filter((g) => g.name)
				.map((g) => ({ id: settingsSectionId(tab.id, g.name), label: g.name }));
			return tab.id === "providers" && sessionAttached()
				? [...named, { id: settingsSectionId(tab.id, LOGIN_SECTION), label: LOGIN_SECTION }]
				: named;
		}
		if (tab.id === "web-ui") {
			return [
				{ id: settingsSectionId("web-ui", "Interface"), label: "Interface" },
				...(signedIn() ? [{ id: settingsSectionId("web-ui", "Account"), label: "Account" }] : []),
			];
		}
		return [];
	};

	const searching = () => query().trim() !== "";
	const results = () => {
		const m = model();
		return m && searching() ? filterSettings(m, query()) : [];
	};
	const webHits = () =>
		searching()
			? filterWebUiSettings(query(), { sessionAttached: sessionAttached(), signedIn: signedIn() })
			: [];
	const featureHits = () => (searching() ? searchFeatures(query()) : []);
	const noMatches = () =>
		searching() &&
		model() !== null &&
		results().length === 0 &&
		webHits().length === 0 &&
		featureHits().length === 0;
	// Matches grouped by tab, then by section. filterSettings returns matches
	// in tab order, so Map insertion order keeps the tab grouping.
	const resultGroups = () => {
		const byTitle = new Map<string, SettingsMatch[]>();
		for (const match of results()) {
			// The SDK names its tab "Appearance"; the sheet labels it Display.
			const title = `${settingsTabMeta(match.tab.id)?.label ?? match.tab.label} · ${match.group.name}`;
			const list = byTitle.get(title) ?? [];
			list.push(match);
			byTitle.set(title, list);
		}
		return [...byTitle.entries()];
	};
	// Non-model hits grouped by the tab that renders them.
	const webGroups = () => {
		const byTab = new Map<string, string[]>();
		for (const row of webHits()) byTab.set(row.tabId, [...(byTab.get(row.tabId) ?? []), row.label]);
		return [...byTab.entries()].map(([tabId, labels]) => ({
			tabId,
			title: settingsTabMeta(tabId)?.label ?? tabId,
			labels,
		}));
	};

	// The tab the stream is scrolled to; a position that is no longer visible
	// (a model refresh dropped it) falls back to the first tab.
	const streamTabId = () => {
		const picked = position().tabId;
		return picked !== null && tabs().some((t) => t.id === picked)
			? picked
			: defaultSettingsTabId(tabs());
	};
	// While searching, the nav highlights the first tab that holds a hit.
	const searchTabId = () => {
		const hits = new Set<string>([
			...results().map((m) => m.tab.id),
			...webHits().map((r) => r.tabId),
			...(featureHits().length > 0 ? ["features"] : []),
		]);
		return tabs().find((t) => hits.has(t.id))?.id ?? streamTabId();
	};
	const navTabId = () => (searching() ? searchTabId() : streamTabId());
	const sections = () => {
		const tab = tabs().find((t) => t.id === navTabId());
		return tab ? sectionsOf(tab) : [];
	};
	const navSectionId = () => {
		const id = position().sectionId;
		return !searching() && id !== null && sections().some((s) => s.id === id) ? id : null;
	};

	// Scroll-spy over the live DOM: tab headings, then the active tab's section headings.
	const measure = (): StreamPosition => {
		const bodyTop = bodyRef.getBoundingClientRect().top;
		const line = bodyRef.clientHeight * SPY_LINE_FRACTION;
		const edge =
			bodyRef.scrollTop <= EDGE_SLACK_PX
				? "top"
				: bodyRef.scrollHeight - bodyRef.scrollTop - bodyRef.clientHeight <= EDGE_SLACK_PX
					? "bottom"
					: null;
		const topOf = (id: string) =>
			(document.getElementById(id)?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY) -
			bodyTop;
		const list = tabs();
		const tabIndex = Math.max(
			0,
			scrollSpyIndex(
				list.map((t) => topOf(settingsTabHeadingId(t.id))),
				line,
				edge,
			),
		);
		const tab = list[tabIndex];
		if (!tab) return { tabId: null, sectionId: null };
		const own = sectionsOf(tab);
		const sectionIndex = scrollSpyIndex(
			own.map((s) => topOf(s.id)),
			line,
			edge,
		);
		return { tabId: tab.id, sectionId: own[sectionIndex]?.id ?? null };
	};
	const updatePosition = () => {
		const next = measure();
		const prev = position();
		if (next.tabId !== prev.tabId || next.sectionId !== prev.sectionId) setPosition(next);
	};

	// Programmatic scroll: a short eased glide over `--dur-move-base` (0 under
	// reduced motion, so the jump is instant). A jump longer than one body
	// height first cuts to one body height short of the target, so every glide
	// covers the same short distance however far apart the headings are.
	const moveDurationMs = (): number => {
		const raw = getComputedStyle(bodyRef).getPropertyValue("--dur-move-base").trim();
		const value = Number.parseFloat(raw);
		if (!Number.isFinite(value)) return 0;
		return raw.endsWith("ms") ? value : value * 1000;
	};
	// The scroll events of the final write are dispatched before the next
	// frame's callbacks, so the highlight stays on the target until then.
	const endGlide = () => {
		scrollFrame = requestAnimationFrame(() => {
			scrollFrame = 0;
			navigating = false;
		});
	};
	const stopGlide = () => {
		if (!navigating) return;
		cancelAnimationFrame(scrollFrame);
		scrollFrame = 0;
		navigating = false;
	};
	const glideTo = (top: number, instant: boolean) => {
		cancelAnimationFrame(scrollFrame);
		navigating = true;
		const to = Math.max(0, Math.min(top, bodyRef.scrollHeight - bodyRef.clientHeight));
		const duration = instant ? 0 : moveDurationMs();
		if (duration <= 0 || to === bodyRef.scrollTop) {
			bodyRef.scrollTop = to;
			endGlide();
			return;
		}
		const reach = bodyRef.clientHeight;
		const from =
			Math.abs(to - bodyRef.scrollTop) > reach
				? to - Math.sign(to - bodyRef.scrollTop) * reach
				: bodyRef.scrollTop;
		const start = performance.now();
		const step = (now: number) => {
			const t = Math.min(1, (now - start) / duration);
			// Quartic ease-out, close to the `--ease-out` curve.
			bodyRef.scrollTop = from + (to - from) * (1 - (1 - t) ** 4);
			if (t < 1) scrollFrame = requestAnimationFrame(step);
			else endGlide();
		};
		bodyRef.scrollTop = from;
		scrollFrame = requestAnimationFrame(step);
	};
	const scrollToTarget = (instant: boolean) => {
		const target = pending;
		const el = target && document.getElementById(target.elementId);
		if (!target || !el) return;
		// The first heading lands at the very top, so the body's own padding stays visible.
		const first = tabs()[0];
		const top =
			first && target.elementId === settingsTabHeadingId(first.id)
				? 0
				: bodyRef.scrollTop + el.getBoundingClientRect().top - bodyRef.getBoundingClientRect().top;
		glideTo(top, instant);
	};
	const go = (target: ScrollTarget, instant: boolean) => {
		pending = target;
		setPosition({ tabId: target.tabId, sectionId: target.sectionId });
		scrollToTarget(instant);
	};
	// Nav and picker clicks clear a search first, then scroll once the stream is visible again.
	const navigate = (target: ScrollTarget) => {
		if (!searching()) {
			go(target, false);
			return;
		}
		deferred = null;
		setQuery("");
		queueMicrotask(() => go(target, false));
	};
	const tabTarget = (id: string): ScrollTarget => ({
		elementId: settingsTabHeadingId(id),
		tabId: id,
		sectionId: null,
	});
	const selectTab = (id: string) => navigate(tabTarget(id));
	const selectSection = (id: string) =>
		navigate({ elementId: id, tabId: navTabId(), sectionId: id });

	// Search begins at the top of the results and, on clearing, returns the
	// stream to where it was (or to a deep link that arrived meanwhile).
	const changeQuery = (next: string) => {
		const was = searching();
		const will = next.trim() !== "";
		if (!was && will) savedScroll = bodyRef.scrollTop;
		setQuery(next);
		if (was === will) return;
		queueMicrotask(() => {
			if (will) {
				bodyRef.scrollTop = 0;
				return;
			}
			if (deferred) {
				const target = deferred;
				deferred = null;
				go(target, true);
				return;
			}
			bodyRef.scrollTop = savedScroll;
			updatePosition();
		});
	};

	const onScroll = () => {
		// Scroll events of a programmatic scroll never move the highlight.
		if (searching() || navigating) return;
		pending = null;
		if (spyFrame !== 0) return;
		spyFrame = requestAnimationFrame(() => {
			spyFrame = 0;
			if (!searching() && !navigating) updatePosition();
		});
	};

	// A deep link (Alt+M, /model, a palette pick) names a
	// tab to scroll to; consume it once. The first one lands instantly. While
	// a search is showing it waits for the search to clear.
	createEffect(() => {
		if (state.settingsTab === null) return;
		const id = consumeSettingsTab();
		const tab = id ? tabs().find((t) => t.id === id) : undefined;
		if (!tab) return;
		untrack(() => {
			const target = tabTarget(tab.id);
			if (searching()) deferred = target;
			else go(target, !mounted);
		});
	});
	// The stream is short until the model arrives, so a deep link scrolled to
	// before then is applied again once it has loaded.
	createEffect(
		on(
			() => state.settingsLoading,
			(loading) => {
				if (!loading && pending && !searching()) scrollToTarget(true);
			},
			{ defer: true },
		),
	);
	// Tabs appearing or the model changing shifts the headings; re-spy unless a scroll target is held.
	createEffect(
		on(
			[tabs, model],
			() =>
				requestAnimationFrame(() => {
					if (mounted && !pending && !navigating && !searching()) updatePosition();
				}),
			{ defer: true },
		),
	);

	onMount(() => {
		mounted = true;
		// Any user scroll input hands the body back mid-glide.
		for (const type of USER_SCROLL_EVENTS)
			bodyRef.addEventListener(type, stopGlide, { passive: true });
		void refreshSettings();
		// Search takes focus on open where no soft keyboard would pop up. The
		// microtask runs after Modal's own mount focus on its box.
		if (searchAutofocus()) queueMicrotask(() => searchRef.focus());
	});
	onCleanup(() => {
		mounted = false;
		for (const type of USER_SCROLL_EVENTS) bodyRef.removeEventListener(type, stopGlide);
		cancelAnimationFrame(scrollFrame);
		cancelAnimationFrame(spyFrame);
	});

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
					<h2 class="settings-title">Settings</h2>
					<div class="settings-search-field">
						<SearchIcon class="settings-search-icon" />
						<input
							ref={searchRef}
							class="settings-search"
							type="text"
							aria-label="Search settings"
							placeholder="Search settings…"
							value={query()}
							onInput={(e) => changeQuery(e.currentTarget.value)}
						/>
					</div>
				</>
			}
		>
			{/* Narrow-layout navigation (CSS-gated below 768px): a section
			    picker instead of the wide layout's sidebar. */}
			<SettingsSectionPicker
				tabs={tabs()}
				activeTabId={navTabId()}
				activeSectionId={navSectionId()}
				sections={sections()}
				onSelectTab={selectTab}
				onSelectSection={selectSection}
			/>
			<div class="settings-content">
				<SettingsNav
					tabs={tabs()}
					activeTabId={navTabId()}
					activeSectionId={navSectionId()}
					changedCounts={changedCounts()}
					sections={sections()}
					onSelectTab={selectTab}
					onSelectSection={selectSection}
				/>
				<div class="settings-body" ref={bodyRef} onScroll={onScroll}>
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
						<Index each={webGroups()}>
							{(group) => (
								<SettingsGroup title={group().title}>
									<Index each={group().labels}>
										{(label) => (
											<SettingsRowLayout label={label()}>
												<button
													type="button"
													class="settings-control-btn"
													onClick={() => selectTab(group().tabId)}
												>
													Open
												</button>
											</SettingsRowLayout>
										)}
									</Index>
								</SettingsGroup>
							)}
						</Index>
						<Show when={noMatches()}>
							<div class="settings-note">
								No settings match "{query().trim()}".{" "}
								<button type="button" class="settings-control-btn" onClick={() => changeQuery("")}>
									Clear Search
								</button>
							</div>
						</Show>
					</Show>
					{/* Kept mounted while searching (hidden) so fold state and scroll survive. */}
					<div class="settings-stream" hidden={searching()}>
						<Show when={model() === null}>
							<div class="settings-note">
								{state.settingsLoading ? "Loading settings…" : "Settings unavailable."}
							</div>
						</Show>
						<For each={tabs()}>
							{(tab) => (
								<section class="settings-tab" aria-labelledby={settingsTabHeadingId(tab.id)}>
									<h2 class="settings-tab-heading" id={settingsTabHeadingId(tab.id)}>
										{tab.label}
									</h2>
									<SettingsTabBody tab={tab} schema={schemaTab(tab.id)} />
								</section>
							)}
						</For>
					</div>
				</div>
			</div>
		</Modal>
	);
};

/** One tab's body in the stream. `schema` is the model tab behind an SDK tab (null before it loads). */
const SettingsTabBody: Component<{
	tab: SettingsTabMeta;
	schema: SettingsTab | null;
}> = (props) => (
	<Switch>
		<Match when={props.tab.id === "session"}>
			<SessionSettings />
		</Match>
		<Match when={props.tab.id === "web-ui"}>
			<WebUiSettings />
		</Match>
		<Match when={props.tab.id === "features"}>
			<FeaturesSettings />
		</Match>
		<Match when={props.tab.kind === "sdk"}>
			<Show when={props.tab.id === "model"}>
				<ModelRoleTable />
			</Show>
			<Show when={props.schema}>
				{(schema) => (
					<Index each={schema().groups}>
						{(group) => (
							<SettingsGroup
								title={group().name}
								id={settingsSectionId(props.tab.id, group().name)}
								collapsible
							>
								<Index each={group().items}>{(item) => <SettingsRow item={item()} />}</Index>
							</SettingsGroup>
						)}
					</Index>
				)}
			</Show>
			{/* Login lives with the provider settings; it needs a live session to talk to. */}
			<Show when={props.tab.id === "providers" && !fleetSettingsActive()}>
				<SettingsGroup title={LOGIN_SECTION} id={settingsSectionId("providers", LOGIN_SECTION)}>
					<SettingsRowLayout label="Login Providers">
						<button
							type="button"
							class="settings-control-btn"
							onClick={() => setState("modal", "login")}
						>
							Manage
						</button>
					</SettingsRowLayout>
				</SettingsGroup>
			</Show>
		</Match>
	</Switch>
);
