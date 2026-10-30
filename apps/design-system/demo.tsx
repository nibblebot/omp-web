import { boot } from "./boot";
import { onCleanup, Show, type Component } from "solid-js";
import { Portal } from "solid-js/web";
import { resyncTheme } from "../web/state";
import { AppView } from "./app-view";
import { entryByStoryId } from "./catalog";
import { labelMode } from "./labels";
import { StoryView } from "./stage";

const TITLE = "omp web design demo";

/** `?embed=<storyId>` selects the inspector's iframe. It is read from the query, never the hash. */
const embedId = new URLSearchParams(location.search).get("embed");

/**
 * One story with no chrome: the parent inspector shows its metadata. The parent's
 * theme controls persist through the theme actions (localStorage), which fires
 * `storage` here; re-applying the stored selection follows it. Writing an
 * unchanged value fires no event, so this cannot loop.
 */
const Embed: Component<{ id: string }> = (props) => {
	document.body.dataset.dsView = "embed";
	const follow = () => resyncTheme();
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

/**
 * The DEMO badge and the label shortcuts, docked in the App's own sidebar just above its Usage
 * panel. The sidebar is App markup, so this renders into a host element kept at that spot: it is
 * (re)inserted whenever the sidebar mounts, before `.sidebar-usage`, or at the panel's end while
 * Usage is hidden (a Usage panel that appears later is appended after it).
 */
const SidebarDemoNote: Component = () => {
	const host = document.createElement("div");
	host.className = "ds-demo-note-host";
	const place = (): void => {
		const panel = document.querySelector(".ds-app-stage .sidebar-panel");
		if (panel === null) return;
		const usage = panel.querySelector(":scope > .sidebar-usage");
		if (host.parentElement === panel && (usage === null || host.nextElementSibling === usage)) {
			return;
		}
		panel.insertBefore(host, usage);
	};
	const observer = new MutationObserver(place);
	observer.observe(document.getElementById("root")!, { childList: true, subtree: true });
	queueMicrotask(place);
	onCleanup(() => {
		observer.disconnect();
		host.remove();
	});
	return (
		<Portal mount={host}>
			<div class="ds-demo-note">
				<span
					class="ds-demo-badge"
					title="Demo: fixture data only; no fleet, session, or model runs behind it"
				>
					Demo
				</span>
				<div class="ds-shortcuts" aria-label="Component label shortcuts">
					<span class="ds-shortcuts-title">Hold to label components</span>
					<span class="ds-shortcut" classList={{ "ds-shortcut--active": labelMode() === "hover" }}>
						<kbd>Shift</kbd>
						<span>under pointer</span>
					</span>
					<span class="ds-shortcut" classList={{ "ds-shortcut--active": labelMode() === "all" }}>
						<kbd>Ctrl</kbd>+<kbd>Shift</kbd>
						<span>all</span>
					</span>
				</div>
			</div>
		</Portal>
	);
};

/** The demo page: the App view filling the window, with the demo note in its sidebar. Every hash belongs to the App. */
const Demo: Component = () => {
	document.body.dataset.dsView = "app";
	return (
		<div class="ds-page">
			<AppView />
			<SidebarDemoNote />
		</div>
	);
};

boot(TITLE, () => (embedId === null ? <Demo /> : <Embed id={embedId} />));
