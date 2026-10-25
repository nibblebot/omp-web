import type { Component } from "solid-js";
import { DockHost } from "../../../web/components/app/DockHost";
import { answerCalls } from "../../session";
import { sessionGraphPage } from "../../fixtures/dialogs";
import { closeDock, openAgents, openDock, setAgentsFilter } from "../../../web/store/dock";
import { seedAgentsDock } from "../../fixtures/subagents";
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
					<button type="button" onClick={() => openDock("tree")}>
						Session tree
					</button>
					<button type="button" onClick={openAgents}>
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
			name: "Session tree open",
			description: "The tree kind mounts the session tree pane in the dock.",
			seed: () => openDock("tree"),
			render: () => <DockStage />,
		},
		{
			name: "Agents open",
			description:
				"The agents kind mounts the agents list (flush body, its own inset) with the Single agent / Accordion view toggle in the header. A row opens that agent's pane; Back returns here.",
			seed: () => seedAgentsDock("single"),
			render: () => <DockStage />,
		},
		{
			name: "Agents open, Running filter",
			description:
				"The header shows the Running / All filter left of the view toggle. With Running pressed the list keeps running and pending agents and the ancestors that hold them, and hides the finished ones; the footer still totals the whole forest.",
			seed: () => {
				seedAgentsDock("single");
				setAgentsFilter("running");
			},
			render: () => <DockStage />,
		},
		{
			name: "Agent open (single view)",
			description:
				"The agent kind mounts one agent's pane. The header toggle switches to the accordion and carries this agent along, expanded in the list.",
			seed: () => seedAgentsDock("single", "FixtureBuilder"),
			render: () => <DockStage />,
		},
		{
			name: "Agents accordion",
			description:
				"The accordion view: clicking a row expands that agent under it (one at a time), and the toggle switches back to the single view with the expanded agent open in its pane.",
			seed: () => seedAgentsDock("accordion", "FixtureBuilder"),
			render: () => <DockStage />,
		},
	],
});
