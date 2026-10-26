import { Show, type Component } from "solid-js";
import { jobWidgetView } from "../../store/job-widgets";
import { settingValue } from "../../store/settings";
import type { SubagentNode } from "../../store/subagents";
import { formatCost, formatDuration, formatTokens } from "../../subagents/format";
import { createLiveElapsed } from "../../subagents/elapsed";
import { formatLiveLine } from "../../subagents/progress";
import { subagentRowDomId } from "../../subagents/tree";
import { JobWidgetGlance } from "../jobs/JobWidget";
import { ChevronDownIcon, ChevronRightIcon } from "../ui/icons";
import { SubagentActionsMenu } from "./SubagentActionsMenu";
import { SubagentStatusChip } from "./SubagentStatusChip";

/** One tree row: expander, then the agent (opens its pane) in two columns: name, title and live line on the left; status, model and metrics on the right. */
export const SubagentTreeRow: Component<{
	node: SubagentNode;
	level: number;
	expanded: boolean;
	onToggle: () => void;
	onOpen: (id: string) => void;
	/** Accordion single-select: `aria-selected` and the highlight. Omit outside a selection model. */
	selected?: boolean;
	/** DOM id of the expanded region this row controls (`aria-controls`); omit while collapsed. */
	controlsId?: string;
	/** The Open in Analysis kebab at the row's end; on unless the host turns it off (the Activities panel). */
	menu?: boolean;
}> = (props) => {
	const hasChildren = () => props.node.children.length > 0;
	const elapsedMs = createLiveElapsed(() => props.node);
	/** Left of the metrics: only while running, and only when the live preview display setting is on. */
	const liveText = () => {
		const live = props.node.live;
		if (live === undefined || settingValue<boolean>("display.subagentLivePreview") !== true) {
			return undefined;
		}
		return formatLiveLine(live) || undefined;
	};
	/** The widget glance of the agent's task job (its job id is the agent id), only while the agent runs and the session reports one. */
	const glance = () => (props.node.status === "running" ? jobWidgetView(props.node.id) : undefined);
	return (
		<div class="subagent-tree-row" data-selected={props.selected === true ? "" : undefined}>
			<Show when={hasChildren()}>
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
				id={subagentRowDomId(props.node.id)}
				role="treeitem"
				class="subagent-tree-open"
				data-subagent-id={props.node.id}
				aria-level={props.level}
				aria-expanded={hasChildren() ? props.expanded : undefined}
				aria-selected={props.selected}
				aria-controls={props.controlsId}
				onClick={() => props.onOpen(props.node.id)}
			>
				<span class="subagent-tree-line">
					<span class="subagent-tree-name" title={props.node.id}>
						{props.node.name}
					</span>
					<Show when={props.node.agentType}>
						{(type) => <span class="subagent-tree-type">{type()}</span>}
					</Show>
				</span>
				<SubagentStatusChip status={props.node.status} />
				<span class="subagent-tree-title" title={props.node.title}>
					{props.node.title}
				</span>
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
				<Show when={glance()}>
					{(view) => (
						<span class="subagent-tree-glance">
							<JobWidgetGlance view={view()} />
						</span>
					)}
				</Show>
			</button>
			<Show when={props.menu !== false}>
				<SubagentActionsMenu id={props.node.id} label={`More actions for ${props.node.name}`} />
			</Show>
		</div>
	);
};
