import { createMemo, For, type Component } from "solid-js";
import { daemonsKey } from "#lib/wire/protocol";
import { capRows } from "../../activities/bar";
import { activityDaemons } from "../../activities/summary";
import { ActivityPopover } from "./ActivityPopover";
import { DaemonRow } from "./DaemonRow";
import { createKeyedRows } from "../../activities/keyed-rows";

/** Condensed daemon list above the bar's Daemons button: name, state, port, restart/kill. Rows are not clickable; the actions act in place. */
export const DaemonsPopover: Component<{ anchor: HTMLElement; onClose: () => void }> = (props) => {
	const rows = createMemo(() => capRows(activityDaemons()));
	// Rows render by key, not by object: every roster frame hands over new daemon objects, and a
	// remounted row would lose its Restart / Kill busy guard.
	const keyed = createKeyedRows(() => rows().shown, daemonsKey);
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
				<For each={keyed.ids()}>
					{(key) => {
						const daemon = keyed.row(key);
						return (
							<li>
								<DaemonRow daemon={daemon()} compact />
							</li>
						);
					}}
				</For>
			</ul>
		</ActivityPopover>
	);
};
