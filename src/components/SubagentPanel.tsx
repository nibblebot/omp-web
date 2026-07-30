import { For, type Component } from "solid-js";
import { state } from "../state";
import { Modal } from "./Modal";
import { SubagentRow } from "./tools/TaskTool";

/** Read-only subagent list: agent, status, description, last update. */
export const SubagentPanel: Component<{ onClose: () => void }> = props => {
	const subs = () => [...state.subagents.values()].sort((a, b) => b.lastUpdate - a.lastUpdate);
	return (
		<Modal title={`Subagents (${subs().length})`} onClose={props.onClose}>
			<div class="subagent-list">
				<For each={subs()}>
					{sub => (
						<div class="subagent-panel-row">
							<SubagentRow sub={sub} />
							<span class="subagent-time">{new Date(sub.lastUpdate).toLocaleTimeString()}</span>
						</div>
					)}
				</For>
				{subs().length === 0 && <div class="tool-collapsed-note">no subagents yet</div>}
			</div>
		</Modal>
	);
};
