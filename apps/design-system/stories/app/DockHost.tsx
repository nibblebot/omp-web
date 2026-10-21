import type { Component } from "solid-js";
import { DockHost } from "../../../web/components/app/DockHost";
import { answerCalls } from "../../daemon";
import { sessionGraphPage } from "../../fixtures/dialogs";
import { closeDock, openDock } from "../../../web/store/dock";
import { defineStory } from "../../registry";

/**
 * The dock inside an `.app-body` row with a stand-in main pane, so the slide
 * (overlay at the right edge, then in the flex row) and the main pane's
 * reflow are visible. The buttons are the real store actions.
 */
const DockStage: Component = () => (
	<div class="ds-frame app-body">
		<div class="main-pane">
			<main class="app-main">
				<p class="picker-note">
					Opening the dock slides it over the right edge, then it joins the row and this pane
					narrows in one step. Closing widens this pane first, then slides the dock out.
				</p>
				<div class="review-actions">
					<button type="button" onClick={() => openDock("review")}>
						Git review
					</button>
					<button type="button" onClick={() => openDock("tree")}>
						Session tree
					</button>
					<button type="button" onClick={() => openDock("agents")}>
						Agents
					</button>
					<button type="button" onClick={closeDock}>
						Close dock
					</button>
				</div>
			</main>
		</div>
		<DockHost />
	</div>
);

export default defineStory({
	id: "app-dock-host",
	title: "DockHost",
	component: { file: "apps/web/components/app/DockHost.tsx", export: "DockHost" },
	seed: () => answerCalls({ getSessionGraph: () => sessionGraphPage }),
	variants: [
		{
			name: "Closed",
			description:
				"No dock kind is set, so the host renders nothing. The buttons open, close and switch panels through the store: switching fades the content, closing slides the dock out.",
			render: () => <DockStage />,
		},
		{
			name: "Git review open",
			description: "The review kind mounts the git review pane in the dock.",
			seed: () => openDock("review"),
			render: () => <DockStage />,
		},
		{
			name: "Session tree open",
			description: "The tree kind mounts the session tree pane in the dock.",
			seed: () => openDock("tree"),
			render: () => <DockStage />,
		},
		{
			name: "Agents open",
			description: "The agents kind mounts the agents list; Back from an agent returns here.",
			seed: () => openDock("agents"),
			render: () => <DockStage />,
		},
	],
});
