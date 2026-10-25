import { SubagentsSection } from "../../../web/components/activities/SubagentsSection";
import { setActivityFilter, toggleItemExpanded } from "../../../web/store/activities";
import { DockFrame, seedActivities, seedAgentTree } from "../../fixtures/subagents";
import { defineStory } from "../../registry";

const section = (width = 520) => (
	<DockFrame title="Activities" width={width} flush>
		<div class="activities-panel">
			<div class="activities-list">
				<SubagentsSection />
			</div>
		</div>
	</DockFrame>
);

export default defineStory({
	id: "activities-subagents-section",
	title: "SubagentsSection",
	component: {
		file: "apps/web/components/activities/SubagentsSection.tsx",
		export: "SubagentsSection",
	},
	variants: [
		{
			name: "Accordion, forest present",
			description:
				"The session's agent forest under the Subagents header, with the All / Running filter and the totals below. A row click expands it inline.",
			seed: () => seedActivities("accordion"),
			render: () => section(),
		},
		{
			name: "Accordion, narrow dock, 420px",
			description:
				"All four row lines fit at the narrowest dock width without horizontal overflow.",
			seed: () => seedActivities("accordion"),
			render: () => section(420),
		},
		{
			name: "Detail mode",
			description:
				"Rows do not expand: a row click opens that agent in the panel. aria-selected is absent on the tree items.",
			seed: () => seedActivities("detail"),
			render: () => section(),
		},
		{
			name: "Several expanded",
			description: "Two agents expanded at once; the tree is aria-multiselectable.",
			seed: () => {
				seedActivities("accordion", "FixtureBuilder");
				toggleItemExpanded({ section: "subagents", id: "DocsSweep" });
			},
			render: () => section(),
		},
		{
			name: "Running filter",
			description: "Running and pending agents with the ancestors that hold them.",
			seed: () => {
				seedActivities("accordion");
				setActivityFilter("subagents", "running");
			},
			render: () => section(),
		},
		{
			name: "Running filter, nothing running",
			description: "Every agent is finished or parked: the section says no subagents are running.",
			seed: () => {
				seedActivities("accordion");
				seedAgentTree({ display: true, settled: true });
				setActivityFilter("subagents", "running");
			},
			render: () => section(),
		},
	],
});
