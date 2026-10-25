import { createMemo, For, type Component } from "solid-js";
import { daemonsKey } from "#lib/wire/protocol";
import { capRows } from "../../activities/bar";
import { activityDaemons } from "../../activities/summary";
import { ActivityPopover } from "./ActivityPopover";
import { DaemonRow } from "./DaemonRow";

/** Condensed daemon list above the bar's Daemons button: name, state, port, restart/kill. Rows are not clickable; the actions act in place. */
export const DaemonsPopover: Component<{ anchor: HTMLElement; onClose: () => void }> = (props) => {
	const rows = createMemo(() => capRows(activityDaemons()));
	return (
		<ActivityPopover
			section="daemons"
			title="Daemons"
			width={440}
			anchor={props.anchor}
			onClose={props.onClose}
			more={rows().more}
		>
			<ul class="activity-popover-list">
				<For each={rows().shown}>
					{(daemon) => (
						<li>
							<DaemonRow daemon={daemon} compact />
						</li>
					)}
				</For>
			</ul>
		</ActivityPopover>
	);
};
