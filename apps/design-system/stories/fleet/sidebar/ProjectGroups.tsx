import { ProjectGroups } from "../../../../web/components/fleet/sidebar/ProjectGroups";
import { rosterSidebarGroups } from "../../../fixtures/roster";
import { seedRosterFleet } from "../../../fixtures/roster-seed";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "fleet-sidebar-project-groups",
	title: "ProjectGroups",
	component: {
		file: "apps/web/components/fleet/sidebar/ProjectGroups.tsx",
		export: "ProjectGroups",
	},
	seed: () => seedRosterFleet(),
	variants: [
		{
			name: "Projects with worktrees and remotes",
			render: () => (
				<div class="sidebar-list">
					<ProjectGroups groups={rosterSidebarGroups} />
				</div>
			),
		},
		{
			name: "No projects yet",
			render: () => (
				<div class="sidebar-list">
					<ProjectGroups groups={[]} />
				</div>
			),
		},
	],
});
