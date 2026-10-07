import { For, Show, type Component } from "solid-js";
import { isActiveSubagent, setState, state } from "../../state";
import { useClickableRow } from "../shared/PickerRow";
import { latestSubagent, SubagentRow } from "../shared/SubagentRow";

/** Live strip above the prompt: visible only while >=1 subagent is in flight. */
export const ActiveSubagents: Component = () => {
	const activeIds = () =>
		[...state.subagents.values()]
			.filter(isActiveSubagent)
			.sort((a, b) => a.index - b.index)
			.map((sub) => sub.id);
	return (
		<Show when={activeIds().length > 0}>
			<div class="active-subagents">
				<For each={activeIds()}>
					{(id) => {
						const sub = latestSubagent((key) => state.subagents.get(key), id);
						return (
							<div
								class="active-subagent-row"
								{...useClickableRow(() => setState("modal", "subagents"))}
							>
								<SubagentRow sub={sub()} />
							</div>
						);
					}}
				</For>
			</div>
		</Show>
	);
};
