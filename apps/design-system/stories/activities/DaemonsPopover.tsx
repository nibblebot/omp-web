import { DaemonsPopover } from "../../../web/components/activities/DaemonsPopover";
import { addDaemonOverflow, seedActivityBar } from "../../fixtures/activity-bar";
import { PopoverAnchor } from "../../fixtures/popover-anchor";
import { defineStory } from "../../registry";

export default defineStory({
	id: "activities-daemons-popover",
	title: "DaemonsPopover",
	component: {
		file: "apps/web/components/activities/DaemonsPopover.tsx",
		export: "DaemonsPopover",
	},
	variants: [
		{
			name: "Live daemons",
			description:
				"Name, state, ready endpoint and restart / kill per daemon. Rows are not clickable; the actions act in place. The popout icon opens the panel at the Daemons section.",
			seed: () => seedActivityBar({ daemons: true }),
			render: () => <PopoverAnchor label="Daemons" popover={DaemonsPopover} />,
		},
		{
			name: "More than eight",
			description: 'Eight rows, then "+N more", which opens the panel at the section.',
			seed: () => {
				seedActivityBar({ daemons: true });
				addDaemonOverflow();
			},
			render: () => <PopoverAnchor label="Daemons" popover={DaemonsPopover} />,
		},
	],
});
