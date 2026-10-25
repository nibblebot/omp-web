import { Match, Switch, type Component } from "solid-js";
import { BotIcon, CodeIcon, LayersIcon, TerminalIcon } from "../ui/icons";

/**
 * What a background job runs, as an icon: a shell command, a subagent or a
 * script. A kind this build does not know draws the generic job icon.
 */
export const JobTypeIcon: Component<{ type: string; class?: string }> = (props) => (
	<Switch fallback={<LayersIcon class={props.class} />}>
		<Match when={props.type === "bash"}>
			<TerminalIcon class={props.class} />
		</Match>
		<Match when={props.type === "task"}>
			<BotIcon class={props.class} />
		</Match>
		<Match when={props.type === "eval"}>
			<CodeIcon class={props.class} />
		</Match>
	</Switch>
);
