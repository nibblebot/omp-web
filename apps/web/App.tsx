import { createEffect, createSignal, onMount, Show, type Component } from "solid-js";
import { NoActiveSessionPane } from "./components/app/NoActiveSessionPane";
import {
	MessageList,
	PromptBox,
	QueueBar,
	SessionConfigBar,
	SessionTitle,
	StatusBar,
} from "./components/chat";
import { EmptyTranscript } from "./components/chat/transcript/EmptyTranscript";
import { ActiveDaemons, FleetSidebar } from "./components/fleet";
import { ActiveSubagents } from "./components/subagents";
import { PanelLeftIcon } from "./components/ui/icons";
import { ModalHost } from "./ModalHost";
import {
	bootAuth,
	connect,
	hasLiveSession,
	initAuth,
	setState,
	setTxSidebarVisible,
	state,
	toggleSidebar,
} from "./state";
import { initTheme } from "./prefs/theme";
import { TranscriptBrowser } from "./tx/TranscriptBrowser";

// Apply persisted theme/font-size before first render to avoid a dark flash.
initTheme();

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
		// Ctrl+R opens history search (suppressed while a modal is open).
		window.addEventListener("keydown", (e) => {
			if (e.key.toLowerCase() !== "r" || !e.ctrlKey || e.shiftKey || e.altKey) return;
			if (state.modal !== null) return;
			e.preventDefault();
			setState("modal", "history");
		});
	});
	// Sticky Analysis keep-alive flag: the first entry into Analysis mounts
	// TranscriptBrowser; later Work/Analysis swaps only toggle its host's display.
	const [analysisOpened, setAnalysisOpened] = createSignal(false);
	createEffect(() => {
		if (state.view === "analysis") setAnalysisOpened(true);
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
					(state.view === "work" && !state.sidebarVisible) ||
					(state.view === "analysis" && !state.txSidebarVisible)
				}
			>
				<button
					type="button"
					id="sidebar-toggle"
					class="sidebar-toggle"
					onClick={() => (state.view === "work" ? toggleSidebar() : setTxSidebarVisible(true))}
					title={state.view === "work" ? "Open roster sidebar" : "Open transcripts sidebar"}
					aria-label={state.view === "work" ? "Open roster sidebar" : "Open transcripts sidebar"}
					aria-expanded={state.view === "work" ? state.sidebarVisible : state.txSidebarVisible}
				>
					<PanelLeftIcon />
				</button>
			</Show>
			<div class="app-body">
				{/* Work view: the docked roster sidebar (it owns its own
					    narrow-viewport scrim). Mounted only in Work; the two-pane
					    swap with Analysis brings its own transcript sidebar inside
					    TranscriptBrowser. First child so it docks LEFT. */}
				<Show when={state.view === "work"}>
					<FleetSidebar />
				</Show>
				{/* Analysis view: the transcript
					    sidebar + detail pane. Keep-alive: once opened, TranscriptBrowser
					    stays mounted and only hides (display:none), so the sidebar
					    list, scroll, search, project filter, and selected
					    transcript all survive view switches. */}
				<Show when={analysisOpened()}>
					<div class="tx-keepalive" classList={{ hidden: state.view !== "analysis" }}>
						<TranscriptBrowser />
					</div>
				</Show>
				<Show when={state.view === "work"}>
					{/* No live session (stopped/removed daemon, or none
						    picked yet): the empty pane replaces the chat column. */}
					<Show
						when={!hasLiveSession()}
						fallback={
							<main class="app-main">
								{/* Session identity (name/rename) at the left edge above the stream. */}
								<SessionTitle />
								<Show
									when={state.items.length > 0 || state.live.active}
									fallback={<EmptyTranscript />}
								>
									<MessageList />
								</Show>
								<QueueBar />
								<div class="active-strips">
									<ActiveSubagents />
									<ActiveDaemons />
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
				</Show>
			</div>
			<ModalHost />
		</div>
	);
};
