import type { Component } from "solid-js";
import { DockHost } from "../../../web/components/app/DockHost";
import { answerCalls } from "../../session";
import { sessionGraphPage } from "../../fixtures/dialogs";
import { openActivities, setActivityFilter } from "../../../web/store/activities";
import { closeDock, openDock } from "../../../web/store/dock";
import { seedActivities } from "../../fixtures/subagents";
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
					<button type="button" onClick={() => openActivities()}>
						Activities
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
			name: "Activities open",
			description:
				"The activities kind mounts the Activities panel (flush body, its own inset) with the Accordion / Detail view toggle in the header. The Subagents section lists the forest; a row expands inline.",
			seed: () => seedActivities("accordion"),
			render: () => <DockStage />,
		},
		{
			name: "Activities open, Running filter",
			description:
				"The Subagents section header carries the Running / All filter. With Running pressed the list keeps running and pending agents and the ancestors that hold them; the footer still totals the whole forest.",
			seed: () => {
				seedActivities("accordion");
				setActivityFilter("subagents", "running");
			},
			render: () => <DockStage />,
		},
		{
			name: "Activities accordion, agent expanded",
			description:
				"The accordion view: clicking a row expands that agent under it, any number at once. The header toggle switches to the detail view and opens the last expanded agent in the panel.",
			seed: () => seedActivities("accordion", "FixtureBuilder"),
			render: () => <DockStage />,
		},
		{
			name: "Activities detail, agent open",
			description:
				"The detail view: one agent fills the panel under a Back strip. Back, or the dock's own Back and Esc, return to the list; the header toggle switches back to the accordion with the agent expanded.",
			seed: () => seedActivities("detail", "FixtureBuilder"),
			render: () => <DockStage />,
		},
	],
});
