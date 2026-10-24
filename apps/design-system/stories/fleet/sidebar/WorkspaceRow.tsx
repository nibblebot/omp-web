import type { DaemonEntry } from "#lib/wire/protocol";
import type { JSX } from "solid-js";
import { WorkspaceRow, setMenuOpenId } from "../../../../web/components/fleet/sidebar/WorkspaceRow";
import { rosterDaemon } from "../../../fixtures/roster";
import { seedRosterFleet } from "../../../fixtures/roster-seed";
import { defineStory } from "../../../registry";

/** A roster column at the docked sidebar width, so truncation and the right-hand controls are judged at 240px. */
const Column = (props: { children: JSX.Element }) => (
	<div class="ds-frame-sidebar">
		<div class="sidebar-list">{props.children}</div>
	</div>
);

/** One row in the sidebar column. */
const Row = (props: {
	daemon: DaemonEntry;
	inProjectGroup?: boolean;
	projectMissing?: boolean;
}) => (
	<Column>
		<WorkspaceRow
			daemon={props.daemon}
			inProjectGroup={props.inProjectGroup}
			projectMissing={props.projectMissing}
		/>
	</Column>
);

const LONG_TITLE =
	"Migrate the roster sidebar rows to content height and move the session controls onto the top line";

/** The attached worktree (ready, idle) with a different last-session title. */
const withTitle = (sessionTitle: string | undefined): DaemonEntry => ({
	...rosterDaemon.worktree,
	sessionTitle,
});

export default defineStory({
	id: "fleet-sidebar-workspace-row",
	title: "WorkspaceRow",
	component: { file: "apps/web/components/fleet/sidebar/WorkspaceRow.tsx", export: "WorkspaceRow" },
	seed: () => seedRosterFleet(),
	variants: [
		{
			name: "Active row, ready and idle (rail, no dot)",
			description:
				"The attached worktree: accent fill without borders, the ready rail on the right edge, and no corner dot because it is idle.",
			render: () => <Row daemon={rosterDaemon.worktree} />,
		},
		{
			name: "Working (spinner)",
			description:
				"A detached main checkout mid-turn: the corner spinner, the rail, and the diffstat line because it has local changes.",
			render: () => <Row daemon={rosterDaemon.main} />,
		},
		{
			name: "Pre-existing linked worktree",
			description: "Asleep and no session yet: one line, a dimmed branch, no rail.",
			render: () => <Row daemon={rosterDaemon.registeredWorktree} />,
		},
		{
			name: "Worktree in project group",
			render: () => <Row daemon={rosterDaemon.worktree} inProjectGroup />,
		},
		{
			name: "Asleep worktree (dimmed)",
			render: () => <Row daemon={rosterDaemon.asleep} />,
		},
		{
			name: "Starting (spinner)",
			render: () => <Row daemon={rosterDaemon.starting} />,
		},
		{
			name: "Clone preparing",
			render: () => <Row daemon={rosterDaemon.clonePreparing} />,
		},
		{
			name: "Clone failed",
			render: () => <Row daemon={rosterDaemon.cloneFailed} />,
		},
		{
			name: "Local-source clone, actions menu (Fetch into project)",
			seed: () => setMenuOpenId(rosterDaemon.cloneLocal.daemonId),
			render: () => <Row daemon={rosterDaemon.cloneLocal} />,
		},
		{
			name: "Remote-source clone, actions menu (no fetch action)",
			seed: () => setMenuOpenId(rosterDaemon.cloneFailed.daemonId),
			render: () => <Row daemon={rosterDaemon.cloneFailed} />,
		},
		{
			name: "Unread output (dot)",
			render: () => <Row daemon={rosterDaemon.localactionMain} />,
		},
		{
			name: "Reconnecting (dot)",
			render: () => <Row daemon={rosterDaemon.reconnecting} />,
		},
		{
			name: "Session error (dot)",
			render: () => <Row daemon={rosterDaemon.sessionError} />,
		},
		{
			name: "Blocked (dot)",
			render: () => <Row daemon={rosterDaemon.blocked} />,
		},
		{
			name: "No session title (one line)",
			description: "A ready, idle worktree with no last-session title and no git changes.",
			render: () => (
				<Row
					daemon={{
						...withTitle(undefined),
						git: { added: 0, modified: 0, deleted: 0, untracked: 0 },
					}}
				/>
			),
		},
		{
			name: "Long title, one line (default)",
			description: "A long session title clamps to one line with an ellipsis.",
			render: () => <Row daemon={withTitle(LONG_TITLE)} />,
		},
		{
			name: "Long title, two lines (setting on)",
			description: "With two-line session titles on, a long title takes two lines.",
			seed: { sidebarSessionTitleLines: 2 },
			render: () => <Row daemon={withTitle(LONG_TITLE)} />,
		},
		{
			name: "Short title, two-line setting on",
			description: "A short title still takes one line; no blank line is reserved.",
			seed: { sidebarSessionTitleLines: 2 },
			render: () => <Row daemon={withTitle("Fixture modules")} />,
		},
		{
			name: "Title first, with diffstat (setting on)",
			description:
				"The session title leads the top line, flush left; the branch sits in small gray text before the diffstat.",
			seed: { sidebarTitleFirst: true },
			render: () => <Row daemon={rosterDaemon.main} />,
		},
		{
			name: "Title first, long title and branch (setting on)",
			description:
				"Both clamp: the title to one line, the branch with an ellipsis before the diffstat.",
			seed: { sidebarTitleFirst: true },
			render: () => (
				<Row
					daemon={{
						...rosterDaemon.main,
						sessionTitle: LONG_TITLE,
						branch: "feat/design-fixtures-for-every-sidebar-state-and-more",
						detachedAt: undefined,
					}}
				/>
			),
		},
		{
			name: "Title first, no git changes (setting on)",
			description:
				"The branch line shows on its own when there is no diffstat; the lock rides with the branch.",
			seed: { sidebarTitleFirst: true },
			render: () => (
				<Row
					daemon={{
						...rosterDaemon.worktree,
						worktreeLocked: true,
						git: { added: 0, modified: 0, deleted: 0, untracked: 0 },
					}}
				/>
			),
		},
		{
			name: "Title first, no session title (setting on)",
			description: "A row without a session title keeps the branch on the top line.",
			seed: { sidebarTitleFirst: true },
			render: () => <Row daemon={withTitle(undefined)} />,
		},
		{
			name: "Long branch name",
			description: "The branch truncates with an ellipsis before the right-hand controls.",
			render: () => (
				<Row
					daemon={{
						...rosterDaemon.worktree,
						branch: "feat/design-fixtures-for-every-sidebar-state-and-more",
					}}
				/>
			),
		},
		{
			name: "Detached worktree",
			render: () => (
				<Row daemon={{ ...rosterDaemon.worktree, branch: undefined, detachedAt: "3f9c2a1" }} />
			),
		},
		{
			name: "Locked worktree",
			render: () => <Row daemon={{ ...rosterDaemon.worktree, worktreeLocked: true }} />,
		},
		{
			name: "Project missing",
			render: () => <Row daemon={rosterDaemon.localactionMain} projectMissing />,
		},
	],
});
