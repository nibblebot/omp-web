import { createSignal, For, Show, type Component } from "solid-js";
import { currentCommandRegistry } from "../../prompt/commands";
import { COMMAND_GROUP_ORDER, isAvailable } from "../../prompt/command-registry";
import { Modal } from "../ui/Modal";
import { Tabs, tabButtonId, tabPanelId, type TabItem } from "../ui/Tabs";

/** Sections of the Help modal. `/help` opens "commands"; `/hotkeys` opens "shortcuts". */
export type HelpTab = "commands" | "shortcuts";

const TABS: TabItem<HelpTab>[] = [
	{ id: "commands", label: "Commands" },
	{ id: "shortcuts", label: "Shortcuts" },
];

const SHORTCUTS: Array<[string, string]> = [
	["Enter", "Send (steers while the agent is streaming)"],
	["Ctrl+Enter", "Queue as follow-up"],
	["Shift+Enter", "Newline"],
	["Esc", "Abort the running turn"],
	["Esc Esc", "Branch picker (empty prompt)"],
	["Ctrl+O", "Expand all tool outputs"],
	["Ctrl+,", "Open Settings"],
	["Ctrl+K", "Command palette"],
	["Alt+A", "Open activities"],
	["Alt+↑", "Pop last queued message into the prompt"],
	["-> / => msg", "Queue as steer / follow-up"],
	["↑", "Pick from prompt history (caret on first line)"],
	["/ …", "Slash commands (Tab completes)"],
	["@ …", "File mentions (Tab completes)"],
	["! cmd", "Run shell command, output into context"],
	["!! cmd", "Run shell command, output local only (dimmed)"],
	["$ code", "Run Python, output into context"],
	["$$ code", "Run Python, output local only (dimmed)"],
];

/** Commands usable in the browser right now, in display group order. */
const commandGroups = () => {
	const entries = currentCommandRegistry().filter(isAvailable);
	return COMMAND_GROUP_ORDER.map((group) => ({
		group,
		entries: entries.filter((entry) => entry.group === group),
	})).filter((group) => group.entries.length > 0);
};

/**
 * Help modal: slash-command reference and keyboard shortcuts in two tabs.
 * `initialTab` is the only difference between `/help` and `/hotkeys`; the
 * tab is local to each mount, so reopening starts from the requested section.
 */
export const ShortcutsDialog: Component<{ initialTab: HelpTab; onClose: () => void }> = (props) => {
	const [tab, setTab] = createSignal<HelpTab>(props.initialTab);
	return (
		<Modal title="Help" onClose={props.onClose}>
			<Tabs tabs={TABS} value={tab()} onChange={setTab} label="Help sections" idPrefix="help" />
			<Show when={tab() === "commands"}>
				<div
					role="tabpanel"
					id={tabPanelId("help", "commands")}
					aria-labelledby={tabButtonId("help", "commands")}
				>
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
				</div>
			</Show>
			<Show when={tab() === "shortcuts"}>
				<div
					role="tabpanel"
					id={tabPanelId("help", "shortcuts")}
					aria-labelledby={tabButtonId("help", "shortcuts")}
				>
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
				</div>
			</Show>
		</Modal>
	);
};
