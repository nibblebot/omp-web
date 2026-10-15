import { For, type Component } from "solid-js";
import { Modal } from "../ui/Modal";

const SHORTCUTS: Array<[string, string]> = [
	["Enter", "Send (steers while the agent is streaming)"],
	["Ctrl+Enter", "Queue as follow-up"],
	["Shift+Enter", "Newline"],
	["Esc", "Abort the running turn"],
	["Esc Esc", "Branch picker (empty prompt)"],
	["Ctrl+O", "Expand all tool outputs"],
	["Alt+↑", "Pop last queued message into the prompt"],
	["-> / => msg", "Queue as steer / follow-up"],
	["↑", "Pick from prompt history (caret on first line)"],
	["/ …", "Slash commands (Tab completes)"],
	["@ …", "File mentions (Tab completes)"],
	["! cmd", "Run shell command, output into context"],
	["!! cmd", "Run shell command, output local only (dimmed)"],
];

/** Keyboard shortcut reference (the "help" modal). */
export const ShortcutsDialog: Component<{ onClose: () => void }> = (props) => (
	<Modal title="Shortcuts" onClose={props.onClose}>
		<table class="shortcuts">
			<tbody>
				<For each={SHORTCUTS}>
					{([key, desc]) => (
						<tr>
							<td class="shortcut-key">{key}</td>
							<td>{desc}</td>
						</tr>
					)}
				</For>
			</tbody>
		</table>
	</Modal>
);
