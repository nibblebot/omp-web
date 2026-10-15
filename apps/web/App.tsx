import { createEffect, createSignal, onMount, Show, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { NoActiveSessionPane } from "./components/app/NoActiveSessionPane";
import {
	PromptBox,
	QueueBar,
	SessionConfigBar,
	SessionTitle,
	StatusBar,
	Transcript,
} from "./components/chat";
import { BackgroundDaemonsBar, FleetSidebar } from "./components/fleet";
import { BackgroundSubagentsBar } from "./components/subagents";
import { PanelLeftIcon } from "./components/ui/icons";
import { ModalHost } from "./ModalHost";
import {
	bootAuth,
	connect,
	hasLiveSession,
	initAuth,
	setState,
	setTxSidebarVisible,
	setView,
	state,
	toggleSidebar,
} from "./state";
import { initTheme } from "./prefs/theme";
import { featureView } from "./features/registry";
import { featurePreferences } from "./features/preferences";

// Apply persisted theme/font-size before first render to avoid a dark flash.
initTheme();

/**
 * Chat mode: the docked roster sidebar (it owns its own narrow-viewport
 * scrim, first so it docks LEFT) plus the live conversation column. App
 * mounts it only while `state.view === "chat"`.
 */
const ChatMode: Component = () => (
	<>
		<FleetSidebar />
		{/* No live session (stopped/removed daemon, or none picked yet): the
		    empty pane replaces the chat column. */}
		<Show
			when={!hasLiveSession()}
			fallback={
				<main class="app-main">
					{/* Session identity (name/rename) at the left edge above the stream. */}
					<SessionTitle />
					<Transcript />
					<QueueBar />
					<div class="background-bars">
						<BackgroundSubagentsBar />
						<BackgroundDaemonsBar />
					</div>
					{/* Session-send config bar (model/thinking/stats), glued to the composer. */}
					<SessionConfigBar />
					<PromptBox />
				</main>
			}
		>
			<main class="app-main">
				<NoActiveSessionPane />
			</main>
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
		// Ctrl+O toggles all tool cards open/closed (not while typing).
		window.addEventListener("keydown", (e) => {
			if (e.key.toLowerCase() !== "o" || !e.ctrlKey || e.shiftKey || e.altKey) return;
			const target = e.target as HTMLElement | null;
			if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) return;
			e.preventDefault();
			setState("toolsExpanded", (v) => !v);
		});
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
			<StatusBar />
			{/* Roster toggle: sticky top-left of the viewport (either view),
				    shown only while the current view's docked sidebar is closed;
				    the open sidebar carries its own close button top-right. Each
				    sidebar collapses independently. */}
			<Show
				when={
					(state.view === "chat" && !state.sidebarVisible) ||
					(state.view === "analysis" && !state.txSidebarVisible)
				}
			>
				<button
					type="button"
					id="sidebar-toggle"
					class="sidebar-toggle"
					onClick={() => (state.view === "chat" ? toggleSidebar() : setTxSidebarVisible(true))}
					title={state.view === "chat" ? "Open roster sidebar" : "Open transcripts sidebar"}
					aria-label={state.view === "chat" ? "Open roster sidebar" : "Open transcripts sidebar"}
					aria-expanded={state.view === "chat" ? state.sidebarVisible : state.txSidebarVisible}
				>
					<PanelLeftIcon />
				</button>
			</Show>
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
