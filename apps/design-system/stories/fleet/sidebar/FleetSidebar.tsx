import type { RosterEntry } from "#lib/wire/protocol";
import type { JSX } from "solid-js";
import { FleetSidebar } from "../../../../web/components/fleet/sidebar/FleetSidebar";
import { GROUPS_KEY } from "../../../../web/components/fleet/sidebar/ProjectGroups";
import {
	applyRosterFrame,
	sendDeleteWorktree,
	setSidebarRunningOnly,
	setState,
	state,
} from "../../../../web/state";
import { toggleSidebar } from "../../../../web/store/roster";
import {
	rosterAppEntries,
	rosterEntry,
	rosterEntries,
	rosterSidebarGroups,
} from "../../../fixtures/roster";
import { seedRosterFleet } from "../../../fixtures/roster-seed";
import { defineStory } from "../../../registry";

/** A worktree that is not in the seeded roster: the row the add/remove variants bring and take away. */
const addedWorktree: RosterEntry = {
	...rosterEntry.worktree,
	workspaceId: "dmn_story_new",
	name: "motion-polish",
	cwd: "/home/joshua/Repos/omp-web-worktrees/motion-polish",
	branch: "feat/motion-polish",
	git: { added: 0, modified: 0, deleted: 0, untracked: 0 },
	sessionTitle: undefined,
	lastSessionFile: undefined,
};

/** The roster delta the fleet edge broadcasts for one added or removed row, through the real store path. */
const addRow = () =>
	applyRosterFrame({ type: "roster_delta", upserted: [addedWorktree], removed: [] });
const removeRow = () =>
	applyRosterFrame({ type: "roster_delta", upserted: [], removed: [addedWorktree.workspaceId] });

/** Story drivers sit above the frame so they stay reachable while the sidebar is hidden. */
const Drivers = (props: { children: JSX.Element }) => (
	<div class="ask-actions">{props.children}</div>
);

const Frame = () => (
	<div class="ds-frame">
		<FleetSidebar />
	</div>
);

/** The pending-delete row: an asleep worktree the fleet edge deletes ("succeeds") or refuses. */
const deletable = rosterEntry.asleep;
let deleteOutcome: "succeeds" | "refused" = "succeeds";
const DELETE_ANSWER_MS = 1500;

const deleteCommands = {
	// A refusal is an uncorrelated error frame (state.error); an accepted delete ends with
	// the roster removal. Both arrive a while after the click so the dim is visible.
	delete_worktree: () => {
		setTimeout(() => {
			if (deleteOutcome === "refused") {
				setState("error", "Delete refused: the worktree has unpushed commits");
				return;
			}
			applyRosterFrame({ type: "roster_delta", upserted: [], removed: [deletable.workspaceId] });
		}, DELETE_ANSWER_MS);
	},
};

export default defineStory({
	id: "fleet-sidebar",
	title: "FleetSidebar",
	component: {
		file: "apps/web/components/fleet/sidebar/FleetSidebar.tsx",
		export: "FleetSidebar",
	},
	seed: () => seedRosterFleet(),
	variants: [
		{
			name: "Projects and fleet",
			description:
				"No PROJECTS header: the groups start at the top and the list ends with the Add project row.",
			render: () => <Frame />,
		},
		{
			name: "Collapsed groups",
			description:
				"Each collapsed project shows its live/total summary (or `N asleep`) and the most urgent row signal in the corner column.",
			seed: () =>
				localStorage.setItem(
					GROUPS_KEY,
					JSON.stringify(rosterSidebarGroups.map((g) => `project:${g.project.projectId}`)),
				),
			render: () => <Frame />,
		},
		{
			name: "Running only",
			description:
				"The header filter is on (set through the real setSidebarRunningOnly): asleep rows are hidden, every other status stays, and nixos-config, whose only row is asleep, keeps its header and shows its summary.",
			seed: () => {
				seedRosterFleet({
					sessionRoster: [
						...rosterEntries.filter((d) => d.projectId !== "proj_nixos_config"),
						...rosterAppEntries.filter(
							(d) => d.projectId === "proj_nixos_config" && d.status === "asleep",
						),
					],
				});
				setSidebarRunningOnly(true);
			},
			render: () => <Frame />,
		},
		{
			name: "Usage panel hidden",
			seed: () => seedRosterFleet({ sidebarUsage: false }),
			render: () => <Frame />,
		},
		{
			name: "First run, no projects",
			description: "The empty hint with the Add project row right under it.",
			seed: () =>
				seedRosterFleet({ registeredProjects: [], sessionRoster: [], daemons: new Map() }),
			render: () => <Frame />,
		},
		{
			name: "Add and remove a worktree row",
			description:
				"Add worktree upserts a roster row (it alone slides open and fades in); Remove worktree drops it (it fades and collapses). Rows already listed never animate.",
			seed: () => seedRosterFleet(),
			render: () => (
				<>
					<Drivers>
						<button type="button" onClick={addRow}>
							Add worktree
						</button>
						<button type="button" onClick={removeRow}>
							Remove worktree
						</button>
					</Drivers>
					<Frame />
				</>
			),
		},
		{
			name: "Delete pending",
			description:
				"Delete worktree submits the real delete: the row dims at once. When the fleet answers it collapses (succeeds) or the dim clears (refused).",
			seed: () => {
				deleteOutcome = "succeeds";
				seedRosterFleet({}, deleteCommands);
			},
			render: () => (
				<>
					<Drivers>
						<button
							type="button"
							onClick={() => {
								deleteOutcome = "succeeds";
								sendDeleteWorktree(deletable.workspaceId);
							}}
						>
							Delete {deletable.name} (succeeds)
						</button>
						<button
							type="button"
							onClick={() => {
								deleteOutcome = "refused";
								sendDeleteWorktree(deletable.workspaceId);
							}}
						>
							Delete {deletable.name} (refused)
						</button>
					</Drivers>
					<Frame />
				</>
			),
		},
		{
			name: "Toggle sidebar",
			description: "Show/hide goes through the real toggleSidebar action.",
			seed: () => seedRosterFleet(),
			render: () => (
				<>
					<Drivers>
						<button type="button" onClick={toggleSidebar}>
							{state.sidebarVisible ? "Hide sidebar" : "Show sidebar"}
						</button>
					</Drivers>
					<Frame />
				</>
			),
		},
	],
});
