import { For, onMount, Show, type Component } from "solid-js";
import { characterForProvider } from "./characters";
import { PanelLeftIcon } from "./icons";
import { ActiveSubagents } from "./components/ActiveSubagents";
import { ActiveDaemons } from "./components/ActiveDaemons";
import { AskDialog } from "./components/AskDialog";
import { BranchPicker } from "./components/BranchPicker";
import { BtwPanel } from "./components/BtwPanel";
import { CharacterAvatar } from "./components/CharacterAvatar";
import { DangerConfirmDialog } from "./components/ConfirmDialog";
import { DaemonSidebar } from "./components/DaemonSidebar";
import { AddProjectModal } from "./components/AddProjectModal";
import { WorktreeModal } from "./components/WorktreeModal";
import { DeleteWorktreeDialog } from "./components/DeleteWorktreeDialog";
import { RemoveProjectDialog } from "./components/RemoveProjectDialog";
import { DebugPanel } from "./components/DebugPanel";
import { GoalPopover } from "./components/GoalPopover";
import { HistorySearch } from "./components/HistorySearch";
import { UsagePanel } from "./components/UsagePanel";
import { LoginPanel } from "./components/LoginPanel";
import { MessageList } from "./components/MessageList";
import { Modal } from "./components/Modal";
import { ModelPicker } from "./components/ModelPicker";
import { Pet } from "./components/Pet";
import { PromptBox } from "./components/PromptBox";
import { QueueBar } from "./components/QueueBar";
import { SessionPicker } from "./components/SessionPicker";
import { SettingsPanel } from "./components/SettingsPanel";
import { StatsPopover } from "./components/StatsPopover";
import { SessionBar, SessionHeader, StatusBar } from "./components/StatusBar";
import { SubagentPanel } from "./components/SubagentPanel";
import { ThinkingPicker } from "./components/ThinkingPicker";
import { connect, setPromptInsert, setState, state, toggleSidebar } from "./state";
import { initTheme } from "./theme";
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
const SUGGESTED_PROMPTS = ["Summarize this repo", "Explain the server protocol", "List open issues"];

const EmptyState: Component = () => (
	<div class="empty-state">
		<CharacterAvatar provider={state.model?.provider} pose="happy" size={96} />
		<p class="empty-greeting">{characterForProvider(state.model?.provider).name} is ready. What should we work on? Ctrl+O expands tool outputs, and Ctrl+R searches prompt history.</p>
		<div class="empty-chips">
			<For each={SUGGESTED_PROMPTS}>
				{text => (
					<button type="button" class="empty-chip" onClick={() => setPromptInsert({ text })}>
						{text}
					</button>
				)}
			</For>
		</div>
	</div>
);

export const App: Component = () => {
	onMount(() => {
		connect();
		// Ctrl+O toggles all tool cards open/closed (not while typing).
		window.addEventListener("keydown", e => {
			if (e.key.toLowerCase() !== "o" || !e.ctrlKey || e.shiftKey || e.altKey) return;
			const target = e.target as HTMLElement | null;
			if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) return;
			e.preventDefault();
			setState("toolsExpanded", v => !v);
		});
		// Ctrl+R opens history search (suppressed while a modal is open).
		window.addEventListener("keydown", e => {
			if (e.key.toLowerCase() !== "r" || !e.ctrlKey || e.shiftKey || e.altKey) return;
			if (state.modal !== null) return;
			e.preventDefault();
			setState("modal", "history");
		});
	});
	return (
		<div class="app">
			{/* finding #P1: always-mounted aria-live region (WCAG 4.1.3). Announcements
			    are written by state.announce() — never conditionally rendered, so
			    screen readers register the polite region at mount. */}
			<div role="status" aria-live="polite" class="visually-hidden">{state.announcement}</div>
			<StatusBar />
			{/* Roster toggle: sticky top-left of the viewport (roster mode,
			    chat view), shown only while the docked sidebar is closed —
			    the open sidebar carries its own close button top-right. */}
			<Show when={state.sessionMode === "roster" && state.view === "chat" && !state.sidebarVisible}>
				<button
					type="button"
					id="sidebar-toggle"
					class="sidebar-toggle"
					onClick={toggleSidebar}
					title="Open roster sidebar"
					aria-label="Open roster sidebar"
					aria-expanded={state.sidebarVisible}
				>
					<PanelLeftIcon />
				</button>
			</Show>
			<div class="app-body">
				{/* Roster mode (fleet edge): the docked fleet roster sidebar; single
				    mode has no sidebar at all. First child so it docks LEFT, and
				    mounted in every view (not just chat) because the transcripts
				    toggle now lives in its footer. */}
				<Show when={state.sessionMode === "roster"}>
					<DaemonSidebar />
				</Show>
				<Show when={state.view === "transcripts"}>
					<TxBrowser />
				</Show>
				<Show when={state.view === "chat"}>
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
				</Show>
			</div>
			<Show when={state.petVisible}>
				<Pet />
			</Show>
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
				<ModelPicker onClose={() => setState("modal", null)} />
			</Show>
			<Show when={state.modal === "thinking"}>
				<ThinkingPicker onClose={() => setState("modal", null)} />
			</Show>
			<Show when={state.modal === "stats"}>
				<StatsPopover onClose={() => setState("modal", null)} />
			</Show>
			<Show when={state.modal === "settings"}>
				<SettingsPanel onClose={() => setState("modal", null)} />
			</Show>
			<Show when={state.modal === "subagents"}>
				<SubagentPanel onClose={() => setState("modal", null)} />
			</Show>
			<Show when={state.modal === "sessions"}>
				<SessionPicker onClose={() => setState("modal", null)} />
			</Show>
			<Show when={state.modal === "branch"}>
				<BranchPicker onClose={() => setState("modal", null)} />
			</Show>
			<Show when={state.modal === "history"}>
				<HistorySearch onClose={() => setState("modal", null)} />
			</Show>
			<Show when={state.modal === "login"}>
				<LoginPanel onClose={() => setState("modal", null)} />
			</Show>
			<Show when={state.modal === "goal"}>
				<GoalPopover onClose={() => setState("modal", null)} />
			</Show>
			<Show when={state.modal === "usage"}>
				<UsagePanel onClose={() => setState("modal", null)} />
			</Show>
			<Show when={state.modal === "debug"}>
				<DebugPanel onClose={() => setState("modal", null)} />
			</Show>
			<Show when={state.modal === "add-project"}>
				<AddProjectModal onClose={() => setState("modal", null)} />
			</Show>
			<Show when={state.modal === "worktree"}>
				<WorktreeModal onClose={() => setState("modal", null)} />
			</Show>
			<AskDialog />
			<BtwPanel />
			<DangerConfirmDialog />
			<DeleteWorktreeDialog />
			<RemoveProjectDialog />
		</div>
	);
};
