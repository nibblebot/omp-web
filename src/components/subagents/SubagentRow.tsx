import { Dynamic } from "solid-js/web";
import type { Component } from "solid-js";
import type { SubagentInfo } from "../../state";
import { BanIcon, CheckIcon, LoaderIcon, XIcon, type IconProps } from "../shared/icons";

export const STATUS_ICON: Record<string, Component<IconProps>> = {
	started: LoaderIcon,
	running: LoaderIcon,
	completed: CheckIcon,
	done: CheckIcon,
	failed: XIcon,
	error: XIcon,
	aborted: BanIcon,
};

/** One roster row for a subagent: status glyph, agent, description, status text. */
export const SubagentRow: Component<{ sub: SubagentInfo }> = (props) => (
	<div class="subagent-row">
		<span class="subagent-glyph" data-status={props.sub.status}>
			<Dynamic component={STATUS_ICON[props.sub.status] ?? LoaderIcon} />
		</span>
		<span class="subagent-agent">{props.sub.agent}</span>
		<span class="subagent-desc">{props.sub.description ?? props.sub.task ?? ""}</span>
		<span class="subagent-status">{props.sub.status}</span>
	</div>
);
