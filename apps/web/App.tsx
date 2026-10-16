import { createEffect, createSignal, on, onCleanup, onMount, Show, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { MainHeader } from "./components/app/MainHeader";
import { NoActiveSessionPane } from "./components/app/NoActiveSessionPane";
import {
	PromptBox,
	QueueBar,
	SessionConfigBar,
	SessionTitle,
	Transcript,
	TranscriptViewMenu,
} from "./components/chat";
import { BackgroundDaemonsBar, FleetSidebar } from "./components/fleet";
import { BackgroundSubagentsBar } from "./components/subagents";
import { ModalHost } from "./ModalHost";
import {
	bootAuth,
	closeDrawers,
	connect,
	hasLiveSession,
	initAuth,
	setState,
	setView,
	state,
} from "./state";
import { initTheme } from "./prefs/theme";
import { trackViewportHeight } from "./prefs/viewport";
import { featureView } from "./features/registry";
import { featurePreferences } from "./features/preferences";
// Apply persisted theme/font-size before first render to avoid a dark flash.
initTheme();

/**
 * Chat mode: the roster sidebar (it owns its own narrow-viewport scrim, first
 * so it docks LEFT) plus the main pane: the full-width MainHeader over the
 * centered conversation column. App mounts it only while `state.view === "chat"`.
 */
const ChatMode: Component = () => (
	<>
		<FleetSidebar />
		{/* No live session (stopped/removed daemon, or none picked yet): the
		    empty pane replaces the chat column. */}
		<Show
			when={!hasLiveSession()}
			fallback={
				<div class="main-pane">
					<MainHeader title={<SessionTitle />} actions={<TranscriptViewMenu />} session />
					<main class="app-main">
						<Transcript />
						<QueueBar />
						<div class="background-bars">
							<BackgroundSubagentsBar />
							<BackgroundDaemonsBar />
						</div>
						{/* Session-send config bar (per-turn badges, model/thinking/stats), glued to the composer. */}
						<SessionConfigBar />
						<PromptBox />
					</main>
				</div>
			}
		>
			<div class="main-pane">
				<MainHeader />
				<main class="app-main">
					<NoActiveSessionPane />
				</main>
			</div>
		</Show>
	</>
);

/**
 * Analysis mode: the transcript sidebar + detail pane, supplied by the
 * analysis feature's `view` slot. Keep-alive: the first entry into Analysis
 * mounts the view; later Chat/Analysis swaps only toggle its host's display,
 * so the sidebar list, scroll, search, project filter, and selected transcript
 * all survive view switches. Renders nothing while analysis is disabled.
 */
const AnalysisMode: Component = () => {
	const [opened, setOpened] = createSignal(false);
	createEffect(() => {
		if (state.view === "analysis") setOpened(true);
	});
	return (
		<Show when={opened() && featureView("analysis")}>
			{(View) => (
				<div class="tx-keepalive" classList={{ hidden: state.view !== "analysis" }}>
					<Dynamic component={View()} />
				</div>
			)}
		</Show>
	);
};

export const App: Component = () => {
	onMount(() => {
		connect();
		// Browser-auth: mirror auth snapshots into state + open the sign-in
		// modal on signedOut; then probe the session (404 → disabled).
		initAuth();
		bootAuth();
		onCleanup(trackViewportHeight());
		// Ctrl+O toggles all tool cards open/closed (not while typing).
		window.addEventListener("keydown", (e) => {
			if (e.key.toLowerCase() !== "o" || !e.ctrlKey || e.shiftKey || e.altKey) return;
			const target = e.target as HTMLElement | null;
			if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) return;
			e.preventDefault();
			setState("toolsExpanded", (v) => !v);
		});
	});
	// Drawer sidebars (below 1024px) get out of the way once the main pane
	// changes (attach, session switch) or any dialog/sheet opens over it.
	createEffect(
		on([() => state.currentSessionId, () => state.sessionFile], () => closeDrawers(), {
			defer: true,
		}),
	);
	createEffect(() => {
		if (
			state.modal !== null ||
			state.daemonDetailsId !== null ||
			state.deleteWorkspaceTarget !== null ||
			state.removeProjectTarget !== null
		)
			closeDrawers();
	});
	// Switching Analysis off in Settings hides the mode switch at once, so
	// leave Analysis immediately rather than strand the user until reload.
	createEffect(() => {
		if (state.view === "analysis" && !featurePreferences().analysis) setView("chat");
	});
	return (
		<div class="app">
			{/* finding #P1: always-mounted aria-live region (WCAG 4.1.3). Announcements
				    are written by state.announce(), never conditionally rendered, so
				    screen readers register the polite region at mount. */}
			<div role="status" aria-live="polite" class="visually-hidden">
				{state.announcement}
			</div>
			<div class="app-body">
				{/* The inactive mode renders nothing (Chat) or a display:none
				    host (Analysis keep-alive), so the active mode lays out alone. */}
				<Show when={state.view === "chat"}>
					<ChatMode />
				</Show>
				<AnalysisMode />
			</div>
			<ModalHost />
		</div>
	);
};
