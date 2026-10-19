import { DockHost } from "../../../web/components/app/DockHost";
import { answerCalls } from "../../daemon";
import { sessionGraphPage } from "../../fixtures/dialogs";
import { openDock } from "../../../web/store/dock";
import { defineStory } from "../../registry";

export default defineStory({
	id: "app-dock-host",
	title: "DockHost",
	component: { file: "apps/web/components/app/DockHost.tsx", export: "DockHost" },
	variants: [
		{
			name: "Closed",
			description: "No dock kind is set, so the host renders nothing.",
			render: () => <DockHost />,
		},
		{
			name: "Git review open",
			description: "The review kind mounts the git review pane in the dock.",
			seed: { dock: { kind: "review" } },
			render: () => <DockHost />,
		},
		{
			name: "Session tree open",
			description: "The tree kind mounts the session tree pane in the dock.",
			seed: () => {
				openDock("tree");
				answerCalls({ getSessionGraph: () => sessionGraphPage });
			},
			render: () => <DockHost />,
		},
	],
});
