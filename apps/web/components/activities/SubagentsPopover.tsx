import { createMemo, For, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { activeFirst, capRows } from "../../activities/bar";
import { openActivities } from "../../store/activities";
import { subagentForest } from "../../store/subagents";
import { flattenSubagentTree, isActiveSubagent } from "../../subagents/tree";
import { ActivityPopover } from "./ActivityPopover";
import { createKeyedRows } from "../../activities/keyed-rows";
import { SUBAGENT_STATUS_ICON } from "./subagent-icons";

/** Condensed subagent list above the bar's Subagents button: status, name, one-line task. A row opens that agent in the panel. */
export const SubagentsPopover: Component<{ anchor: HTMLElement; onClose: () => void }> = (
	props,
) => {
	const rows = createMemo(() =>
		capRows(activeFirst(flattenSubagentTree(subagentForest()), isActiveSubagent)),
	);
	// Rows render by id, not by object: every forest rebuild hands over new nodes.
	const keyed = createKeyedRows(
		() => rows().shown,
		(node) => node.id,
	);
	return (
		<ActivityPopover
			section="subagents"
			title="Subagents"
			anchor={props.anchor}
			onClose={props.onClose}
			more={rows().more}
		>
			<ul class="activity-popover-list">
				<For each={keyed.ids()}>
					{(id) => {
						const node = keyed.row(id);
						return (
							<li>
								<button
									type="button"
									class="activity-popover-row"
									onClick={() => {
										openActivities({ item: { section: "subagents", id } });
										props.onClose();
									}}
								>
									<span
										class="activity-popover-glyph"
										classList={{ "activity-popover-glyph--spin": node().status === "running" }}
										data-status={node().status}
									>
										<Dynamic component={SUBAGENT_STATUS_ICON[node().status]} />
									</span>
									<span class="activity-popover-name">{node().name}</span>
									<span class="activity-popover-detail" title={node().title}>
										{node().title}
									</span>
								</button>
							</li>
						);
					}}
				</For>
			</ul>
		</ActivityPopover>
	);
};
