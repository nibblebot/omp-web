import { For, createEffect, createSignal, onMount, Show, type Component } from "solid-js";
import { characterForProvider } from "./sprites/characters";
import { PanelLeftIcon } from "./components/shared/icons";
import { CharacterAvatar, Modal } from "./components/shared";
import {
	MessageList,
	PromptBox,
	QueueBar,
	SessionBar,
	SessionHeader,
	StatusBar,
} from "./components/chat";
import { ActiveSubagents, SubagentPanel } from "./components/subagents";
import {
	ActiveDaemons,
	AddProjectModal,
	DaemonSidebar,
	DeleteWorkspaceDialog,
	RemoveProjectDialog,
	WorkspaceModal,
} from "./components/roster";
import { SignInModal } from "./components/SignInModal";
import {
	AskDialog,
	BranchModal,
	BtwPanel,
	DangerConfirmDialog,
	DebugModal,
	GoalModal,
	HistoryModal,
	LoginModal,
	ModelModal,
	SessionModal,
	SettingsModal,
	StatsModal,
	ThinkingModal,
	Toasts,
	UsageModal,
} from "./components/overlays";
import {
	bootAuth,
	connect,
	hasLiveSession,
	initAuth,
	openStoredHistory,
	setPromptInsert,
	setSidebarVisible,
	setState,
	setTxSidebarVisible,
	state,
	toggleSidebar,
} from "./state";
import { initTheme } from "./prefs/theme";
import { TxBrowser } from "./tx/Browser";

// Apply persisted theme/font-size before first render to avoid a dark flash.
initTheme();

const SHORTCUTS: Array<[string, string]> = [
	["Enter", "Send (steers while the agent is streaming)"],
	["Ctrl+Enter", "Queue as follow-up"],
	["Shift+Enter", "Newline"],
	["Esc", "Abort the running turn"],
	["Esc Esc", "Branch picker (empty prompt)"],
	["Ctrl+R", "Fuzzy-search prompt history"],
	["Ctrl+O", "Expand all tool outputs"],
	["Alt+↑", "Pop last queued message into the prompt"],
	["-> / => msg", "Queue as steer / follow-up"],
	["↑ / ↓", "Prompt history (caret on first/last line)"],
	["/ …", "Slash commands (Tab completes)"],
	["@ …", "File mentions (Tab completes)"],
	["! cmd", "Run shell command, output into context"],
	["!! cmd", "Run shell command, output local only (dimmed)"],
];

/** First-run empty state: large character sprite, greeting, and suggested
 *  prompts that insert into the prompt box (consumed by PromptBox). */
const SUGGESTED_PROMPTS = [
	"Summarize this repo",
	"Explain the server protocol",
	"List open issues",
];

const EmptyState: Component = () => (
	<div class="empty-state">
		<CharacterAvatar provider={state.model?.provider} pose="happy" size={96} />
		<p class="empty-greeting">
			{characterForProvider(state.model?.provider).name} is ready. What should we work on? Ctrl+O
			expands tool outputs, and Ctrl+R searches prompt history.
		</p>
		<div class="empty-chips">
			<For each={SUGGESTED_PROMPTS}>
				{(text) => (
					<button type="button" class="empty-chip" onClick={() => setPromptInsert({ text })}>
						{text}
					</button>
				)}
			</For>
		</div>
	</div>
);

/** Roster mode with no live session (the attached daemon was stopped,
 *  removed, or never picked): a quiet centered hint replaces the whole chat
 *  column — header/stream/composer all belong to a session that is gone. */
const NoActiveSessionPane: Component = () => (
	<div class="roster-empty-pane">
		<p class="roster-empty-title">No active session</p>
		<p class="roster-empty-hint">Pick a daemon from the sidebar to start a session.</p>
	</div>
);

/**
 * Roster mode where the attached worker is gone but its transcript is still in
 * memory (the pod shut down, the cluster became unreachable, the session was
 * stopped): keep showing that history READ-ONLY instead of throwing it away.
 * Read-only by construction: no composer, no queue, no send config, and no
 * rename affordance. The retained clone identity (state.readOnlySessionId)
 * offers the full-fidelity copy from the fleet store, which needs no worker.
 */
const ReadOnlySessionPane: Component = () => (
	<main class="app-main">
		<div class="session-header">
			<h1 class="segment session-name session-readonly-title">
				{state.sessionName ?? state.sessionId.slice(0, 8)}
			</h1>
		</div>
		<div class="session-readonly-strip" role="status">
			<span>worker not connected — history is read-only</span>
			{/* Retained clone id, else the still-attached transitional clone. */}
			<Show when={state.readOnlySessionId ?? (state.currentSessionId || null)} keyed>
				{(id) => (
					<button type="button" class="btn btn-small" onClick={() => void openStoredHistory(id)}>
						Open stored history
					</button>
				)}
			</Show>
		</div>
		<MessageList />
	</main>
);

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
	// TxBrowser; later Work/Analysis swaps only toggle its host's display.
	const [analysisOpened, setAnalysisOpened] = createSignal(false);
	createEffect(() => {
		if (state.view === "analysis") setAnalysisOpened(true);
	});
	return (
		<div class="app">
			{/* finding #P1: always-mounted aria-live region (WCAG 4.1.3). Announcements
			    are written by state.announce() — never conditionally rendered, so
			    screen readers register the polite region at mount. */}
			<div role="status" aria-live="polite" class="visually-hidden">
				{state.announcement}
			</div>
			<StatusBar />
			{/* Roster toggle: sticky top-left of the viewport (roster mode,
			    either view), shown only while the current mode's docked
			    sidebar is closed — the open sidebar carries its own close
			    button top-right. Each mode collapses independently. */}
			<Show
				when={
					state.sessionMode === "roster" &&
					((state.view === "work" && !state.sidebarVisible) ||
						(state.view === "analysis" && !state.txSidebarVisible))
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
				{/* Work mode (roster + fleet edge): the docked roster sidebar.
				    Mounted only in Work; the two-pane swap with Analysis — which
				    brings its own transcript sidebar inside TxBrowser. Single mode
				    has no sidebar at all. First child so it docks LEFT. */}
				<Show when={state.sessionMode === "roster" && state.view === "work"}>
					<DaemonSidebar />
					{/* Narrow-viewport slide-out: tapping outside the overlay sidebar
					    closes it. Hidden by CSS on wide layouts, where the sidebar
					    docks instead of overlaying. */}
					<Show when={state.sidebarVisible}>
						<button
							type="button"
							class="sidebar-scrim"
							tabindex={-1}
							onClick={() => setSidebarVisible(false)}
							aria-label="Close sidebar"
						/>
					</Show>
				</Show>
				{/* Analysis mode (roster only; /ctl/stats needs a fleet process):
				    the transcript sidebar + detail pane. Standalone never renders
				    it, even if omp.view persisted "analysis". Keep-alive: once
				    opened, TxBrowser stays mounted and only hides (display:none), so
				    the sidebar list, scroll, search, project filter, and selected
				    transcript all survive mode switches. */}
				<Show when={state.sessionMode === "roster" && analysisOpened()}>
					<div class="tx-keepalive" classList={{ hidden: state.view !== "analysis" }}>
						<TxBrowser />
					</div>
				</Show>
				<Show when={state.view === "work" || state.sessionMode !== "roster"}>
					{/* Roster mode: a live session renders the interactive chat; a
					    session whose worker is gone keeps its last-known transcript
					    visible but READ-ONLY (constraint: an unreachable worker's
					    history is readable, never writable); only a session that has
					    no transcript at all falls back to the empty pane. Standalone
					    mode is never gated — hasLiveSession() is true outside roster. */}
					<Show
						when={state.sessionMode === "roster" && !hasLiveSession()}
						fallback={
							<main class="app-main">
								{/* Session identity (name/rename) at the left edge above the stream. */}
								<SessionHeader />
								<Show when={state.items.length > 0 || state.live.active} fallback={<EmptyState />}>
									<MessageList />
								</Show>
								<QueueBar />
								<div class="active-strips">
									<ActiveSubagents />
									<ActiveDaemons />
								</div>
								{/* Session-send config bar (model/thinking/stats), glued to the composer. */}
								<SessionBar />
								<PromptBox />
							</main>
						}
					>
						<Show
							when={state.items.length > 0 || state.live.active}
							fallback={
								<main class="app-main">
									<NoActiveSessionPane />
								</main>
							}
						>
							<ReadOnlySessionPane />
						</Show>
					</Show>
				</Show>
			</div>
			<Show when={state.modal === "help"}>
				<Modal title="Shortcuts" onClose={() => setState("modal", null)}>
					<table class="shortcuts">
						<tbody>
							{SHORTCUTS.map(([key, desc]) => (
								<tr>
									<td class="shortcut-key">{key}</td>
									<td>{desc}</td>
								</tr>
							))}
						</tbody>
					</table>
				</Modal>
			</Show>
			<Show when={state.modal === "model"}>
				<ModelModal onClose={() => setState("modal", null)} />
			</Show>
			<Show when={state.modal === "thinking"}>
				<ThinkingModal onClose={() => setState("modal", null)} />
			</Show>
			<Show when={state.modal === "stats"}>
				<StatsModal onClose={() => setState("modal", null)} />
			</Show>
			<Show when={state.modal === "settings"}>
				<SettingsModal onClose={() => setState("modal", null)} />
			</Show>
			<Show when={state.modal === "subagents"}>
				<SubagentPanel onClose={() => setState("modal", null)} />
			</Show>
			<Show when={state.modal === "sessions"}>
				<SessionModal onClose={() => setState("modal", null)} />
			</Show>
			<Show when={state.modal === "branch"}>
				<BranchModal onClose={() => setState("modal", null)} />
			</Show>
			<Show when={state.modal === "history"}>
				<HistoryModal onClose={() => setState("modal", null)} />
			</Show>
			<Show when={state.modal === "login"}>
				<LoginModal onClose={() => setState("modal", null)} />
			</Show>
			<Show when={state.modal === "goal"}>
				<GoalModal onClose={() => setState("modal", null)} />
			</Show>
			<Show when={state.modal === "usage"}>
				<UsageModal onClose={() => setState("modal", null)} />
			</Show>
			<Show when={state.modal === "debug"}>
				<DebugModal onClose={() => setState("modal", null)} />
			</Show>
			<Show when={state.modal === "add-project"}>
				<AddProjectModal onClose={() => setState("modal", null)} />
			</Show>
			<Show when={state.modal === "workspace"}>
				<WorkspaceModal onClose={() => setState("modal", null)} />
			</Show>
			<Show when={state.modal === "sign-in"}>
				<SignInModal onClose={() => setState("modal", null)} />
			</Show>
			<AskDialog />
			<BtwPanel />
			<DangerConfirmDialog />
			<DeleteWorkspaceDialog />
			<RemoveProjectDialog />
			<Toasts />
		</div>
	);
};
