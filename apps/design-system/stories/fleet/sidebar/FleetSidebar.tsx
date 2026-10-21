import type { DaemonEntry } from "#lib/wire/protocol";
import type { JSX } from "solid-js";
import { FleetSidebar } from "../../../../web/components/fleet/sidebar/FleetSidebar";
import { applyRosterFrame, sendDeleteWorktree, setState, state } from "../../../../web/state";
import { toggleSidebar } from "../../../../web/store/roster";
import { rosterDaemon } from "../../../fixtures/roster";
import { seedRosterFleet } from "../../../fixtures/roster-seed";
import { defineStory } from "../../../registry";

/** A worktree that is not in the seeded roster: the row the add/remove variants bring and take away. */
const addedWorktree: DaemonEntry = {
	...rosterDaemon.worktree,
	daemonId: "dmn_story_new",
	name: "motion-polish",
	cwd: "/home/joshua/Repos/omp-web-worktrees/motion-polish",
	branch: "feat/motion-polish",
	git: { added: 0, modified: 0, deleted: 0, untracked: 0 },
	labels: [],
	sessionTitle: undefined,
	lastSessionFile: undefined,
};

/** The roster delta the fleet edge broadcasts for one added or removed row, through the real store path. */
const addRow = () =>
	applyRosterFrame({ type: "roster_delta", upserted: [addedWorktree], removed: [] });
const removeRow = () =>
	applyRosterFrame({ type: "roster_delta", upserted: [], removed: [addedWorktree.daemonId] });

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
const deletable = rosterDaemon.asleep;
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
			applyRosterFrame({ type: "roster_delta", upserted: [], removed: [deletable.daemonId] });
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
			render: () => <Frame />,
		},
		{
			name: "Usage panel hidden",
			seed: () => seedRosterFleet({ sidebarUsage: false }),
			render: () => <Frame />,
		},
		{
			name: "First run, no projects",
			seed: () => seedRosterFleet({ registeredProjects: [], daemonRoster: [], daemons: new Map() }),
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
								sendDeleteWorktree(deletable.daemonId);
							}}
						>
							Delete {deletable.name} (succeeds)
						</button>
						<button
							type="button"
							onClick={() => {
								deleteOutcome = "refused";
								sendDeleteWorktree(deletable.daemonId);
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
