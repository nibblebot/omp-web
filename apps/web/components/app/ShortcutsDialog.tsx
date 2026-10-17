import { For, type Component } from "solid-js";
import { currentCommandRegistry } from "../../prompt/commands";
import { COMMAND_GROUP_ORDER, isAvailable } from "../../prompt/command-registry";
import { Modal } from "../ui/Modal";

const SHORTCUTS: Array<[string, string]> = [
	["Enter", "Send (steers while the agent is streaming)"],
	["Ctrl+Enter", "Queue as follow-up"],
	["Shift+Enter", "Newline"],
	["Esc", "Abort the running turn"],
	["Esc Esc", "Branch picker (empty prompt)"],
	["Ctrl+O", "Expand all tool outputs"],
	["Ctrl+,", "Open Settings"],
	["Alt+A", "Open subagents"],
	["Alt+↑", "Pop last queued message into the prompt"],
	["-> / => msg", "Queue as steer / follow-up"],
	["↑", "Pick from prompt history (caret on first line)"],
	["/ …", "Slash commands (Tab completes)"],
	["@ …", "File mentions (Tab completes)"],
	["! cmd", "Run shell command, output into context"],
	["!! cmd", "Run shell command, output local only (dimmed)"],
];

/** Commands usable in the browser right now, in display group order. */
const commandGroups = () => {
	const entries = currentCommandRegistry().filter(isAvailable);
	return COMMAND_GROUP_ORDER.map((group) => ({
		group,
		entries: entries.filter((entry) => entry.group === group),
	})).filter((group) => group.entries.length > 0);
};

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
		<For each={commandGroups()}>
			{(group) => (
				<section>
					<h3>{group.group}</h3>
					<table class="shortcuts">
						<tbody>
							<For each={group.entries}>
								{(entry) => (
									<tr>
										<td class="shortcut-key">
											/{entry.name}
											{entry.hint ? ` ${entry.hint}` : ""}
										</td>
										<td>{entry.description}</td>
									</tr>
								)}
							</For>
						</tbody>
					</table>
				</section>
			)}
		</For>
	</Modal>
);
