import { createEffect, createSignal, onMount, Show, type Component } from "solid-js";
import { characterForModel } from "./sprites/characters";
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
import {
	ActiveSubagents,
	AdvisorPanel,
	GoalLoopPanel,
	SubagentPanel,
	WorkerFocus,
} from "./components/subagents";
import {
	ActiveDaemons,
	AddProjectModal,
	DaemonSidebar,
	DeleteWorkspaceDialog,
	RemoveProjectDialog,
	WorkspaceModal,
} from "./components/roster";
import { FleetRequiredNotice } from "./components/FleetRequiredNotice";
import { SignInModal } from "./components/SignInModal";
import {
	AskDialog,
	BranchModal,
	BrowserUiRenderer,
	BtwHistoryView,
	BtwPanel,
	CompactionControls,
	DangerConfirmDialog,
	DebugModal,
	DownloadDialog,
	GoalModal,
	HistoryModal,
	LoginModal,
	McpManager,
	ModelModal,
	ResumePicker,
	SessionModal,
	SettingsModal,
	SkillsManager,
	StatsModal,
	ThinkingModal,
	Toasts,
	UsageModal,
	VoiceControls,
} from "./components/overlays";
import { GitPanel } from "./components/review/GitPanel";
import { PlanReview } from "./components/review/PlanReview";
import { AnnotationSidebar } from "./components/review/AnnotationSidebar";
import { TodoBoard } from "./components/review/TodoBoard";
import {
	bootAuth,
	connect,
	hasLiveSession,
	initAuth,
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

/** Empty-transcript state: large character sprite and a one-line greeting. */
const EmptyState: Component = () => (
	<div class="empty-state">
		<CharacterAvatar provider={state.model?.provider} id={state.model?.id} pose="happy" size={96} />
		<p class="empty-greeting">
			{characterForModel(state.model?.provider, state.model?.id).name} is ready. What should we work
			on?
		</p>
	</div>
);

/** No live session (the attached daemon was stopped,
 *  removed, or never picked): a quiet centered hint replaces the whole chat
 *  column. Header/stream/composer all belong to a session that is gone. */
const NoActiveSessionPane: Component = () => (
	<div class="roster-empty-pane">
		<p class="roster-empty-title">No active session</p>
		<p class="roster-empty-hint">Pick a daemon from the sidebar to start a session.</p>
	</div>
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
	// A bare session daemon serves the wire API but no web UI; the fleet is
	// the only UI server, so the notice replaces the entire shell.
	return (
		<Show when={!state.fleetRequired} fallback={<FleetRequiredNotice />}>
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
					{/* Work view: the docked roster sidebar. Mounted only in Work;
					    the two-pane swap with Analysis brings its own transcript
					    sidebar inside TxBrowser. First child so it docks LEFT. */}
					<Show when={state.view === "work"}>
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
					{/* Analysis view (/ctl/stats needs a fleet process, so the
					    fleet-required notice covers a bare daemon): the transcript
					    sidebar + detail pane. Keep-alive: once opened, TxBrowser
					    stays mounted and only hides (display:none), so the sidebar
					    list, scroll, search, project filter, and selected
					    transcript all survive view switches. */}
					<Show when={analysisOpened()}>
						<div class="tx-keepalive" classList={{ hidden: state.view !== "analysis" }}>
							<TxBrowser />
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
									<SessionHeader />
									<Show
										when={state.items.length > 0 || state.live.active}
										fallback={<EmptyState />}
									>
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
							<main class="app-main">
								<NoActiveSessionPane />
							</main>
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
				<Show when={state.modal === "goal"}>
					<GoalModal onClose={() => setState("modal", null)} />
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
				<Show when={state.modal === "mcp"}>
					<McpManager onClose={() => setState("modal", null)} />
				</Show>
				<Show when={state.modal === "skills"}>
					<SkillsManager onClose={() => setState("modal", null)} />
				</Show>
				<Show when={state.modal === "git"}>
					<GitPanel />
				</Show>
				<Show when={state.modal === "plan-review"}>
					<PlanReview />
				</Show>
				<Show when={state.modal === "annotations"}>
					<AnnotationSidebar />
				</Show>
				<Show when={state.modal === "todos"}>
					<TodoBoard />
				</Show>
				<Show when={state.modal === "compaction"}>
					<CompactionControls onClose={() => setState("modal", null)} />
				</Show>
				<Show when={state.modal === "btw-history"}>
					<BtwHistoryView onClose={() => setState("modal", null)} />
				</Show>
				<Show when={state.modal === "voice"}>
					<Show
						when={state.sessionScope}
						keyed
						fallback={<div class="msg-notice">Attach a session before using voice.</div>}
					>
						{(scope) => <VoiceControls scope={scope} />}
					</Show>
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
				<DangerConfirmDialog />
				<DeleteWorkspaceDialog />
				<RemoveProjectDialog />
				<Toasts />
			</div>
		</Show>
	);
};
