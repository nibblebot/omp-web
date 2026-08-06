import { For, Show, type Component } from "solid-js";
import { isActiveSubagent, setState, state } from "../state";
import { SubagentRow } from "./tools/TaskTool";

/** Live strip above the prompt: visible only while >=1 subagent is in flight. */
export const ActiveSubagents: Component = () => {
	const active = () =>
		[...state.subagents.values()].filter(isActiveSubagent).sort((a, b) => a.index - b.index);
	return (
		<Show when={active().length > 0}>
			<div class="active-subagents">
				<For each={active()}>
					{sub => (
						<div
							class="active-subagent-row"
							role="button"
							tabindex={0}
							onClick={() => setState("modal", "subagents")}
							onKeyDown={e => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									setState("modal", "subagents");
								}
							}}
						>
							<SubagentRow sub={sub} />
						</div>
					)}
				</For>
			</div>
		</Show>
	);
};
