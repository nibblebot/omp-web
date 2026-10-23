import type { DaemonEntry } from "#lib/wire/protocol";
import {
	GROUPS_KEY,
	ProjectGroups,
	type ProjectGroupsData,
} from "../../../../web/components/fleet/sidebar/ProjectGroups";
import { rosterDaemon, rosterSidebarGroups } from "../../../fixtures/roster";
import { seedRosterFleet } from "../../../fixtures/roster-seed";
import { defineStory } from "../../../registry";

const [ompWebGroup, localactionGroup, nixosGroup] = rosterSidebarGroups;
const project = ompWebGroup!.project;

/** Further asleep worktrees, so a group can hold several of them (rows are keyed by daemonId). */
const asleepWorktree = (n: number): DaemonEntry => ({
	...rosterDaemon.asleep,
	daemonId: `dmn_story_asleep${n}`,
	name: `asleep-${n}`,
	branch: `chore/asleep-${n}`,
});

/** Collapse the given project groups before the story renders (persisted in localStorage like a click). */
const collapse = (...projectIds: string[]) =>
	localStorage.setItem(GROUPS_KEY, JSON.stringify(projectIds.map((id) => `project:${id}`)));

const inList = (groups: ProjectGroupsData) => (
	<div class="sidebar-list">
		<ProjectGroups groups={groups} />
	</div>
);

/** Nothing live: two asleep worktrees. */
const allAsleep: ProjectGroupsData = [
	{ project, daemons: [rosterDaemon.asleep, rosterDaemon.registeredWorktree] },
];

/** 3 of 5 live; the main checkout is mid-turn (dmn_a001), so the corner shows the spinner. */
const mixedWorking: ProjectGroupsData = [
	{
		project,
		daemons: [
			rosterDaemon.main,
			rosterDaemon.cloneLocal,
			rosterDaemon.worktree,
			rosterDaemon.asleep,
			rosterDaemon.registeredWorktree,
		],
	},
];

/** 2 of 5 live; one of them waits on an extension dialog (dmn_c002), so the corner shows the red dot. */
const mixedBlocked: ProjectGroupsData = [
	{
		project,
		daemons: [
			rosterDaemon.blocked,
			rosterDaemon.cloneLocal,
			rosterDaemon.asleep,
			asleepWorktree(1),
			asleepWorktree(2),
		],
	},
];

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
			description:
				"Every group expanded. The list ends with the Add project row; hover a header for its + and ⋯.",
			render: () => inList(rosterSidebarGroups),
		},
		{
			name: "Collapsed, all asleep",
			description:
				"Nothing live: the muted summary reads `2 asleep`, with no rail mark and no signal.",
			seed: () => collapse(project.projectId),
			render: () => inList(allAsleep),
		},
		{
			name: "Collapsed, mixed with spinner",
			description:
				"Rail mark and `3/5` beside the spinner of the working row; the tooltip lists every state.",
			seed: () => collapse(project.projectId),
			render: () => inList(mixedWorking),
		},
		{
			name: "Collapsed, mixed with blocked dot",
			description:
				"Rail mark and `2/5`; the red dot of the blocked row wins over every other signal.",
			seed: () => collapse(project.projectId),
			render: () => inList(mixedBlocked),
		},
		{
			name: "All groups collapsed",
			description:
				"The three seeded projects: an error row beats working in the first, reconnecting beats unread in the second, blocked shows in the third.",
			seed: () =>
				collapse(
					ompWebGroup!.project.projectId,
					localactionGroup!.project.projectId,
					nixosGroup!.project.projectId,
				),
			render: () => inList(rosterSidebarGroups),
		},
		{
			name: "Missing project",
			render: () =>
				inList(
					rosterSidebarGroups.map((group) =>
						group.project.name === "localaction"
							? { ...group, project: { ...group.project, missing: true } }
							: group,
					),
				),
		},
		{
			name: "No projects yet",
			description: "The hint, then the Add project row.",
			render: () => inList([]),
		},
	],
});
