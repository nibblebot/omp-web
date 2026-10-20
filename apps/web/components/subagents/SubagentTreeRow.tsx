import { createEffect, Show, type Component } from "solid-js";
import { settingValue } from "../../store/settings";
import { isFeatureEnabled } from "../../features/registry";
import {
	ensureAnalysisSessionsDir,
	openAnalysisHash,
	subagentAnalysisHref,
	type SubagentNode,
} from "../../store/subagents";
import { formatCost, formatDuration, formatTokens } from "../../subagents/format";
import { createLiveElapsed } from "../../subagents/elapsed";
import { formatLiveLine } from "../../subagents/progress";
import { ChevronDownIcon, ChevronRightIcon } from "../ui/icons";
import { KebabMenu } from "../ui/KebabMenu";
import { SubagentStatusChip } from "./SubagentStatusChip";

/** One tree row: expander, then the agent (opens its pane) as name, title, model and metrics, and a live line. */
export const SubagentTreeRow: Component<{
	node: SubagentNode;
	level: number;
	expanded: boolean;
	onToggle: () => void;
	onOpen: (id: string) => void;
}> = (props) => {
	const hasChildren = () => props.node.children.length > 0;
	const elapsedMs = createLiveElapsed(() => props.node);
	/** ANA-08 (brnh, km9k): the kebab offers "Open in Analysis" only when Analysis is on and the transcript is known. */
	createEffect(() => {
		if (isFeatureEnabled("analysis")) ensureAnalysisSessionsDir();
	});
	/** Line 4: only while running, and only when the live preview display setting is on. */
	const liveText = () => {
		const live = props.node.live;
		if (live === undefined || settingValue<boolean>("display.subagentLivePreview") !== true) {
			return undefined;
		}
		return formatLiveLine(live) || undefined;
	};
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
					aria-label={`${props.expanded ? "Collapse" : "Expand"} ${props.node.name}`}
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
				<span class="subagent-tree-line">
					<span class="subagent-tree-name" title={props.node.id}>
						{props.node.name}
					</span>
					<Show when={props.node.agentType}>
						{(type) => <span class="subagent-tree-type">{type()}</span>}
					</Show>
					<SubagentStatusChip status={props.node.status} />
				</span>
				<span class="subagent-tree-title" title={props.node.title}>
					{props.node.title}
				</span>
				<span class="subagent-tree-line subagent-tree-stats">
					<Show when={props.node.model}>
						{(model) => (
							<span class="subagent-tree-model" title={model().identity}>
								{model().thinking ? `${model().id} · ${model().thinking}` : model().id}
							</span>
						)}
					</Show>
					<span class="subagent-tree-metrics">
						<Show when={elapsedMs() !== undefined}>
							<span>{formatDuration(elapsedMs() ?? 0)}</span>
						</Show>
						<span>{formatTokens(props.node.metrics.tokens)} tokens</span>
						<span>{formatCost(props.node.metrics.cost)}</span>
						<Show when={props.node.metrics.contextPercent !== undefined}>
							<span>ctx {Math.round(props.node.metrics.contextPercent ?? 0)}%</span>
						</Show>
					</span>
				</span>
				<Show when={liveText()}>
					{(text) => (
						<span
							class="subagent-tree-live"
							data-error={props.node.live?.isError === true ? "true" : undefined}
							title={text()}
						>
							{text()}
						</span>
					)}
				</Show>
			</button>
			{/* ANA-08 (brnh, km9k): hidden, never disabled, when no Analysis link exists. */}
			<Show when={subagentAnalysisHref(props.node.id, isFeatureEnabled("analysis"))}>
				{(href) => (
					<KebabMenu label={`More actions for ${props.node.name}`}>
						<button type="button" role="menuitem" onClick={() => openAnalysisHash(href())}>
							Open in Analysis
						</button>
					</KebabMenu>
				)}
			</Show>
		</div>
	);
};
