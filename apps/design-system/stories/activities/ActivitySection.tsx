import { ActivityFilterToggle } from "../../../web/components/activities/ActivityFilterToggle";
import { ActivitySection } from "../../../web/components/activities/ActivitySection";
import { toggleSectionCollapsed } from "../../../web/store/activities";
import { defineStory } from "../../registry";

const Body = () => <p class="activity-empty">Section content renders here.</p>;

export default defineStory({
	id: "activities-activity-section",
	title: "ActivitySection",
	component: {
		file: "apps/web/components/activities/ActivitySection.tsx",
		export: "ActivitySection",
	},
	variants: [
		{
			name: "Expanded, active count",
			description:
				"Chevron, name and active/total count; the header toggle is a button with aria-expanded and folds the body.",
			render: () => (
				<div class="ds-frame">
					<ActivitySection id="daemons" title="Daemons" count={{ active: 2, total: 3 }}>
						<Body />
					</ActivitySection>
				</div>
			),
		},
		{
			name: "With section actions",
			description:
				"Actions sit beside the toggle, outside it: the Subagents and Jobs sections put their All / Running filter here.",
			render: () => (
				<div class="ds-frame">
					<ActivitySection
						id="jobs"
						title="Jobs"
						count={{ active: 1, total: 4 }}
						actions={<ActivityFilterToggle section="jobs" label="Show jobs" />}
					>
						<Body />
					</ActivitySection>
				</div>
			),
		},
		{
			name: "Done count",
			description: "Todo counts what is done out of the total instead of what is active.",
			render: () => (
				<div class="ds-frame">
					<ActivitySection id="todos" title="Todo" count={{ done: 3, total: 7 }}>
						<Body />
					</ActivitySection>
				</div>
			),
		},
		{
			name: "Collapsed",
			description:
				"Folded: the chevron points right, aria-expanded is false, and the body is not rendered.",
			seed: () => toggleSectionCollapsed("daemons"),
			render: () => (
				<div class="ds-frame">
					<ActivitySection id="daemons" title="Daemons" count={{ active: 2, total: 3 }}>
						<Body />
					</ActivitySection>
				</div>
			),
		},
	],
});
