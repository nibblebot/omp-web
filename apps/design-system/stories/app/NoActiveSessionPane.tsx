import { NoActiveSessionPane } from "../../../web/components/app/NoActiveSessionPane";
import { defineStory } from "../../registry";

export default defineStory({
	id: "app-no-active-session-pane",
	title: "NoActiveSessionPane",
	component: {
		file: "apps/web/components/app/NoActiveSessionPane.tsx",
		export: "NoActiveSessionPane",
	},
	variants: [
		{
			name: "No live session",
			description: "Replaces the chat column when the attached daemon is gone or none is picked.",
			render: () => (
				<div class="ds-frame">
					<main class="app-main">
						<NoActiveSessionPane />
					</main>
				</div>
			),
		},
	],
});
