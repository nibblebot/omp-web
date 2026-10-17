import { createEffect, Show, type Component } from "solid-js";
import { settingValue } from "../../store/settings";
import { isFeatureEnabled } from "../../features/registry";
import {
	ensureAnalysisSessionsDir,
	getWorkerInfo,
	openAnalysisHash,
	subagentAnalysisHref,
	type SubagentNode,
} from "../../store/subagents";
import { state } from "../../state";
import { formatCost, formatDuration, formatTokens } from "../../subagents/format";
import { modelBadge, pickProgress } from "../../subagents/progress";
import { ChevronDownIcon, ChevronRightIcon } from "../ui/icons";
import { KebabMenu } from "../ui/KebabMenu";
import { SubagentStatusChip } from "./SubagentStatusChip";

/** The raw progress payload of one agent, narrowed for the model badge. */
function progressOf(id: string) {
	const info = getWorkerInfo(state.currentSessionId, id);
	return pickProgress(info && "progress" in info ? info.progress : undefined);
}

/** One tree row: expander, the agent (opens its pane), status, live tool, metrics. */
export const SubagentTreeRow: Component<{
	node: SubagentNode;
	level: number;
	expanded: boolean;
	onToggle: () => void;
	onOpen: (id: string) => void;
}> = (props) => {
	const hasChildren = () => props.node.children.length > 0;
	/** ANA-08 (brnh, km9k): the kebab offers "Open in Analysis" only when Analysis is on and the transcript is known. */
	createEffect(() => {
		if (isFeatureEnabled("analysis")) ensureAnalysisSessionsDir();
	});
	const liveTool = () =>
		settingValue<boolean>("display.subagentLivePreview") === true && props.node.status === "running"
			? props.node.lastTool
			: undefined;
	const badge = () =>
		settingValue<boolean>("task.showResolvedModelBadge") === true
			? modelBadge(progressOf(props.node.id))
			: undefined;
	return (
		<div class="subagent-tree-row">
			<Show
				when={hasChildren()}
				fallback={<span class="subagent-tree-toggle-spacer" aria-hidden="true" />}
			>
				<button
					type="button"
					class="subagent-tree-toggle"
					tabIndex={-1}
					aria-label={`${props.expanded ? "Collapse" : "Expand"} ${props.node.label}`}
					onClick={() => props.onToggle()}
				>
					{props.expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
				</button>
			</Show>
			<button
				type="button"
				role="treeitem"
				class="subagent-tree-open"
				data-subagent-id={props.node.id}
				aria-level={props.level}
				aria-expanded={hasChildren() ? props.expanded : undefined}
				onClick={() => props.onOpen(props.node.id)}
			>
				<span class="subagent-tree-name">{props.node.label}</span>
				<Show when={props.node.agentType}>
					{(type) => <span class="subagent-tree-type">{type()}</span>}
				</Show>
				<SubagentStatusChip status={props.node.status} />
				<Show when={liveTool()}>{(tool) => <span class="subagent-tree-live">{tool()}</span>}</Show>
				<Show when={badge()}>{(b) => <span class="subagent-tree-model">{b().model}</span>}</Show>
				<span class="subagent-tree-metrics">
					<Show when={props.node.status !== "pending"}>
						<span>{formatDuration(props.node.metrics.elapsedMs)}</span>
					</Show>
					<span class="subagent-metric-wide">{formatTokens(props.node.metrics.tokens)} tokens</span>
					<span class="subagent-metric-wide">{formatCost(props.node.metrics.cost)}</span>
					<Show when={props.node.metrics.contextPercent !== undefined}>
						<span>ctx {Math.round(props.node.metrics.contextPercent ?? 0)}%</span>
					</Show>
					<Show when={hasChildren()}>
						<span class="subagent-metric-wide">
							subtree {formatTokens(props.node.subtree.tokens)} tokens,{" "}
							{formatCost(props.node.subtree.cost)}
						</span>
					</Show>
				</span>
			</button>
			{/* ANA-08 (brnh, km9k): hidden, never disabled, when no Analysis link exists. */}
			<Show when={subagentAnalysisHref(props.node.id, isFeatureEnabled("analysis"))}>
				{(href) => (
					<KebabMenu label={`More actions for ${props.node.label}`}>
						<button type="button" role="menuitem" onClick={() => openAnalysisHash(href())}>
							Open in Analysis
						</button>
					</KebabMenu>
				)}
			</Show>
		</div>
	);
};
