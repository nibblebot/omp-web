import { Show, type Component } from "solid-js";
import { openActivities } from "../../../store/activities";
import { runningSubagentCount } from "../../../store/subagents";
import { BotIcon } from "../../ui/icons";

/** Composer icon button: robot glyph plus the running-agent count; opens the Activities panel on Subagents.
 *  Hidden when none run. */
export const RunningAgentsButton: Component = () => (
	<Show when={runningSubagentCount() > 0}>
		<button
			type="button"
			class="running-agents-button"
			aria-label={`${runningSubagentCount()} running subagents, open agents panel`}
			aria-keyshortcuts="Alt+A"
			title="Running subagents (Alt+A)"
			onClick={() => openActivities({ section: "subagents" })}
		>
			<BotIcon />
			<span class="running-agents-count">{runningSubagentCount()}</span>
		</button>
	</Show>
);
