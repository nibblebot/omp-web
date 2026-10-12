import { boot } from "./boot";
import { onCleanup, Show, type Component } from "solid-js";
import { currentThemePreference, setTheme } from "../web/prefs/theme";
import { AppView } from "./app-view";
import { entryByStoryId } from "./catalog";
import { labelMode } from "./labels";
import { StoryView } from "./stage";
import { TopBar } from "./topbar";

const TITLE = "omp web design demo";

/** `?embed=<storyId>` selects the inspector's iframe. It is read from the query, never the hash. */
const embedId = new URLSearchParams(location.search).get("embed");

/**
 * One story with no chrome: the parent inspector shows its metadata. The parent's
 * theme switcher persists through setTheme (localStorage), which fires `storage`
 * here; re-applying the stored preference follows it. Writing an unchanged value
 * fires no event, so this cannot loop.
 */
const Embed: Component<{ id: string }> = (props) => {
	document.body.dataset.dsView = "embed";
	const follow = () => setTheme(currentThemePreference());
	window.addEventListener("storage", follow);
	onCleanup(() => window.removeEventListener("storage", follow));
	return (
		<main class="ds-embed">
			<Show
				when={entryByStoryId.get(props.id)}
				fallback={<p class="ds-error">Unknown story: {props.id}</p>}
			>
				{(e) => <StoryView entry={e()} embedded />}
			</Show>
		</main>
	);
};

/** The demo page: the App view under a top bar with the label shortcuts. Every hash belongs to the App. */
const Demo: Component = () => {
	document.body.dataset.dsView = "app";
	return (
		<div class="ds-page">
			<TopBar brand={TITLE} demo>
				<div class="ds-shortcuts" aria-label="Component label shortcuts">
					<span class="ds-shortcut" classList={{ "ds-shortcut--active": labelMode() === "hover" }}>
						<kbd>Shift</kbd>
						<span>label under pointer</span>
					</span>
					<span class="ds-shortcut" classList={{ "ds-shortcut--active": labelMode() === "all" }}>
						<kbd>Ctrl</kbd>+<kbd>Shift</kbd>
						<span>label all</span>
					</span>
					<span class="ds-shortcut ds-shortcut--note">click a label for its design</span>
				</div>
			</TopBar>
			<AppView />
		</div>
	);
};

boot(TITLE, () => (embedId === null ? <Demo /> : <Embed id={embedId} />));
