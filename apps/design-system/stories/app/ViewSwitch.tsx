import { ViewSwitch } from "../../../web/components/app/ViewSwitch";
import { defineStory } from "../../registry";

export default defineStory({
	id: "app-view-switch",
	title: "ViewSwitch",
	component: { file: "apps/web/components/app/ViewSwitch.tsx", export: "ViewSwitch" },
	variants: [
		{
			name: "Work view",
			description: "Work is the active mode.",
			seed: { view: "work", workUnviewed: false },
			render: () => <ViewSwitch />,
		},
		{
			name: "Analysis view",
			description: "Analysis is the active mode.",
			seed: { view: "analysis", workUnviewed: false },
			render: () => <ViewSwitch />,
		},
		{
			name: "Unviewed work turn",
			description:
				"A turn ended unattended in Analysis, so the Work button carries the activity dot.",
			seed: { view: "analysis", workUnviewed: true },
			render: () => <ViewSwitch />,
		},
	],
});
