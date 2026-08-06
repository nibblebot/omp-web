import { onMount, Show, type Component } from "solid-js";
import { ActiveSubagents } from "./components/ActiveSubagents";
import { ActiveDaemons } from "./components/ActiveDaemons";
import { AskDialog } from "./components/AskDialog";
import { BranchPicker } from "./components/BranchPicker";
import { BtwPanel } from "./components/BtwPanel";
import { GoalPopover } from "./components/GoalPopover";
import { HistorySearch } from "./components/HistorySearch";
import { UsagePanel } from "./components/UsagePanel";
import { LoginPanel } from "./components/LoginPanel";
import { Kimi } from "./components/Kimi";
import { MessageList } from "./components/MessageList";
import { Modal } from "./components/Modal";
import { ModelPicker } from "./components/ModelPicker";
import { PromptBox } from "./components/PromptBox";
import { QueueBar } from "./components/QueueBar";
import { SessionPicker } from "./components/SessionPicker";
import { SessionsSidebar } from "./components/SessionsSidebar";
import { SettingsPanel } from "./components/SettingsPanel";
import { StatsPopover } from "./components/StatsPopover";
import { StatusBar } from "./components/StatusBar";
import { SubagentPanel } from "./components/SubagentPanel";
import { ThinkingPicker } from "./components/ThinkingPicker";
import { connect, setState, state } from "./state";
import { initTheme } from "./theme";

// Apply persisted theme/font-size before first render to avoid a dark flash.
initTheme();

const SHORTCUTS: Array<[string, string]> = [
	["Enter", "Send (steers while the agent is streaming)"],
	["Ctrl+Enter", "Queue as follow-up"],
	["Shift+Enter", "Newline"],
	["Esc", "Abort the running turn"],
	["Esc Esc", "Branch picker (empty prompt)"],
	["Ctrl+R", "Fuzzy-search prompt history"],
	["Alt+↑", "Pop last queued message into the prompt"],
	["-> / => msg", "Queue as steer / follow-up"],
	["↑ / ↓", "Prompt history (caret on first/last line)"],
	["/ …", "Slash commands (Tab completes)"],
	["@ …", "File mentions (Tab completes)"],
	["! cmd", "Run shell command, output into context"],
	["!! cmd", "Run shell command, output local only (dimmed)"],
];

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
			<StatusBar />
			<div class="app-body">
				<div class="app-main">
					<MessageList />
					<QueueBar />
					<div class="active-strips">
						<ActiveSubagents />
						<ActiveDaemons />
					</div>
					<PromptBox />
				</div>
				<Show when={state.sidebarVisible}>
					<SessionsSidebar />
				</Show>
			</div>
			<Kimi />
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
			<AskDialog />
			<BtwPanel />
		</div>
	);
};
