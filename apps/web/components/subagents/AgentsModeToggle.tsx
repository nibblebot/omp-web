import { For, type Component } from "solid-js";
import { agentsMode, setAgentsMode, type AgentsMode } from "../../store/dock";
import { Rows3Icon, SquareIcon } from "../ui/icons";

const MODES: readonly { mode: AgentsMode; label: string; icon: Component }[] = [
	{ mode: "single", label: "Single agent view", icon: SquareIcon },
	{ mode: "accordion", label: "Accordion view", icon: Rows3Icon },
];

/** Segmented control in the agents dock header: one agent per pane, or agents expanding inline in the list. */
export const AgentsModeToggle: Component = () => (
	<div class="agents-mode-toggle" role="group" aria-label="Agents view">
		<For each={MODES}>
			{(entry) => (
				<button
					type="button"
					class="segment segment-button"
					classList={{ active: agentsMode() === entry.mode }}
					aria-pressed={agentsMode() === entry.mode}
					aria-label={entry.label}
					title={entry.label}
					onClick={() => setAgentsMode(entry.mode)}
				>
					<entry.icon />
				</button>
			)}
		</For>
	</div>
);
