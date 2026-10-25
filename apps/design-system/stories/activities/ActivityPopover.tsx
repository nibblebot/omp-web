import type { Component } from "solid-js";
import { ActivityPopover } from "../../../web/components/activities/ActivityPopover";
import { PopoverAnchor } from "../../fixtures/popover-anchor";
import { defineStory } from "../../registry";

/** The shared frame around three plain rows, with `more` rows beyond the cap. */
const frameWith =
	(more: number): Component<{ anchor: HTMLElement; onClose: () => void }> =>
	(props) => (
		<ActivityPopover
			section="jobs"
			title="Jobs"
			anchor={props.anchor}
			onClose={props.onClose}
			more={more}
		>
			<ul class="activity-popover-list">
				<li>
					<div class="activity-popover-row">
						<span class="activity-popover-name">bun run dev</span>
						<span class="activity-popover-detail">14m04s</span>
						<span class="activity-popover-state">running</span>
					</div>
				</li>
				<li>
					<div class="activity-popover-row">
						<span class="activity-popover-name">bun test</span>
						<span class="activity-popover-detail">1m13s</span>
						<span class="activity-popover-state">done</span>
					</div>
				</li>
			</ul>
		</ActivityPopover>
	);

export default defineStory({
	id: "activities-activity-popover",
	title: "ActivityPopover",
	component: {
		file: "apps/web/components/activities/ActivityPopover.tsx",
		export: "ActivityPopover",
	},
	// Fixed-position surfaces from several variants would stack over each other.
	tabs: true,
	variants: [
		{
			name: "Header and rows",
			description:
				"The frame the four activity popovers share: the section title, the popout icon that opens the Activities panel at the section (and closes the popover), and the rows the caller supplies.",
			render: () => <PopoverAnchor label="Jobs" popover={frameWith(0)} />,
		},
		{
			name: "With +N more",
			description:
				'Rows beyond the cap leave a "+N more" footer, which opens the panel at the section and closes the popover.',
			render: () => <PopoverAnchor label="Jobs" popover={frameWith(5)} />,
		},
	],
});
