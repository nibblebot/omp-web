import { createSignal, Show, type Component } from "solid-js";
import { isActiveSubagent, setState, state } from "../../state";
import { settingValue } from "../../store/settings";
import { layoutPinned, modelBadge, pinnedAgentsMode } from "../../subagents/progress";
import { BackgroundBar } from "../ui/BackgroundBar";
import { latestSubagent, SubagentRow, SubagentToolPreview, subagentProgress } from "./SubagentRow";

/** Background subagents strip above the prompt: one clickable row per in-flight subagent
    (click or Enter/Space opens the subagents modal). Visible only while >=1 is in flight.
    `display.pinnedAgents` sets the list (`off` hides it, `collapsed` lists 3 rows behind an
    expander, `full` lists all); `display.subagentLivePreview` adds each running row's current
    tool call; `task.showResolvedModelBadge` adds the resolved model to each row. */
export const BackgroundSubagentsBar: Component = () => {
	const [expanded, setExpanded] = createSignal(false);
	const mode = () => pinnedAgentsMode(settingValue("display.pinnedAgents"));
	const activeIds = () =>
		[...state.subagents.values()]
			.filter(isActiveSubagent)
			.sort((a, b) => a.index - b.index)
			.map((sub) => sub.id);
	const layout = () => layoutPinned(activeIds().length, mode() === "full" || expanded());
	const shownIds = () => activeIds().slice(0, layout().rows);
	return (
		<Show when={mode() !== "off" && activeIds().length > 0}>
			<div class="background-subagents">
				<BackgroundBar
					items={shownIds()}
					label="Background subagents"
					onRowClick={() => setState("modal", "subagents")}
				>
					{(id) => {
						const sub = latestSubagent((key) => state.subagents.get(key), id);
						const badge = () =>
							settingValue<boolean>("task.showResolvedModelBadge") === true
								? modelBadge(subagentProgress(id))
								: undefined;
						return (
							<>
								<SubagentRow sub={sub()} badge={badge()} />
								<Show when={settingValue<boolean>("display.subagentLivePreview") === true}>
									<SubagentToolPreview progress={subagentProgress(id)} />
								</Show>
							</>
						);
					}}
				</BackgroundBar>
				<Show when={mode() !== "full" && layout().toggle}>
					{(toggle) => (
						<button
							type="button"
							class="background-subagents-toggle"
							onClick={() => setExpanded(!expanded())}
						>
							{toggle() === "expand" ? `Show all ${activeIds().length}` : "Show fewer"}
						</button>
					)}
				</Show>
			</div>
		</Show>
	);
};
