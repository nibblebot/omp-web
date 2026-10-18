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
			name: "Projects with worktrees and clones",
			render: () => (
				<div class="sidebar-list">
					<ProjectGroups groups={rosterSidebarGroups} />
				</div>
			),
		},
		{
			name: "Missing project",
			render: () => (
				<div class="sidebar-list">
					<ProjectGroups
						groups={rosterSidebarGroups.map((group) =>
							group.project.name === "localaction"
								? { ...group, project: { ...group.project, missing: true } }
								: group,
						)}
					/>
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
