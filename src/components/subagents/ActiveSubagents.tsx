import { For, Show, type Component } from "solid-js";
import { isActiveSubagent, setState, state } from "../../state";
import { useClickableRow } from "../shared/PickerRow";
import { SubagentRow } from "./SubagentRow";

/** Live strip above the prompt: visible only while >=1 subagent is in flight. */
export const ActiveSubagents: Component = () => {
	const active = () =>
		[...state.subagents.values()].filter(isActiveSubagent).sort((a, b) => a.index - b.index);
	return (
		<Show when={active().length > 0}>
			<div class="active-subagents">
				<For each={active()}>
					{(sub) => (
						<div
							class="active-subagent-row"
							{...useClickableRow(() => setState("modal", "subagents"))}
						>
							<SubagentRow sub={sub} />
						</div>
					)}
				</For>
			</div>
		</Show>
	);
};
