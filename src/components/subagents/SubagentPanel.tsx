import { createSignal, For, Show, type Component } from "solid-js";
import { state, type SubagentInfo } from "../../state";
import { Modal } from "../shared/Modal";
import { useClickableRow } from "../shared/PickerRow";
import { SubagentDetail } from "./SubagentDetail";
import { SubagentControls } from "./SubagentControls";
import { SubagentRow } from "../shared/SubagentRow";

/** Read-only subagent list with per-agent transcript drill-down. */
export const SubagentPanel: Component<{ onClose: () => void }> = (props) => {
	const [selected, setSelected] = createSignal<SubagentInfo | null>(null);
	const subs = () => [...state.subagents.values()].sort((a, b) => b.lastUpdate - a.lastUpdate);
	return (
		<Show
			when={selected()}
			fallback={
				<Modal title={`Subagents (${subs().length})`} onClose={props.onClose}>
					<div class="subagent-list">
						<For each={subs()}>
							{(sub) => (
								<div
									class="subagent-panel-row"
									style={{ cursor: "pointer" }}
									{...useClickableRow(() => setSelected(sub))}
								>
									<SubagentRow sub={sub} />
									<Show when={sub.status === "started" || sub.status === "running"}>
										<SubagentControls sub={sub} />
									</Show>
									<span class="subagent-time">{new Date(sub.lastUpdate).toLocaleTimeString()}</span>
								</div>
							)}
						</For>
						{subs().length === 0 && <div class="tool-collapsed-note">no subagents yet</div>}
					</div>
				</Modal>
			}
		>
			{(sub) => (
				<Modal title={sub().agent} onClose={props.onClose}>
					<SubagentDetail sub={sub()} onBack={() => setSelected(null)} />
				</Modal>
			)}
		</Show>
	);
};
