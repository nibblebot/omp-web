import { onMount, Show, type Component } from "solid-js";
import { MessageList } from "./components/MessageList";
import { Modal } from "./components/Modal";
import { ModelPicker } from "./components/ModelPicker";
import { PromptBox } from "./components/PromptBox";
import { SettingsPopover } from "./components/SettingsPopover";
import { StatsPopover } from "./components/StatsPopover";
import { StatusBar } from "./components/StatusBar";
import { ThinkingPicker } from "./components/ThinkingPicker";
import { connect, setState, state } from "./state";

const SHORTCUTS: Array<[string, string]> = [
	["Enter", "Send (steers while the agent is streaming)"],
	["Ctrl+Enter", "Queue as follow-up"],
	["Shift+Enter", "Newline"],
	["Esc", "Abort the running turn"],
	["↑ / ↓", "Prompt history (caret on first/last line)"],
	["/ …", "Slash commands (Tab completes)"],
	["@ …", "File mentions (Tab completes)"],
	["! cmd", "Run shell command, output into context"],
	["!! cmd", "Run shell command, output local only (dimmed)"],
];

export const App: Component = () => {
	onMount(connect);
	return (
		<div class="app">
			<StatusBar />
			<MessageList />
			<PromptBox />
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
				<SettingsPopover onClose={() => setState("modal", null)} />
			</Show>
		</div>
	);
};
