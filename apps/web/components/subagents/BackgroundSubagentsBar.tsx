import type { Component } from "solid-js";
import { isActiveSubagent, setState, state } from "../../state";
import { BackgroundBar } from "../ui/BackgroundBar";
import { latestSubagent, SubagentRow } from "./SubagentRow";

/** Background subagents strip above the prompt: one clickable row per in-flight subagent
    (click or Enter/Space opens the subagents modal). Visible only while >=1 is in flight. */
export const BackgroundSubagentsBar: Component = () => {
	const activeIds = () =>
		[...state.subagents.values()]
			.filter(isActiveSubagent)
			.sort((a, b) => a.index - b.index)
			.map((sub) => sub.id);
	return (
		<BackgroundBar
			items={activeIds()}
			label="Background subagents"
			onRowClick={() => setState("modal", "subagents")}
		>
			{(id) => {
				const sub = latestSubagent((key) => state.subagents.get(key), id);
				return <SubagentRow sub={sub()} />;
			}}
		</BackgroundBar>
	);
};
