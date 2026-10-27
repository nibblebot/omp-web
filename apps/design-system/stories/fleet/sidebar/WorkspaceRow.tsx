import type { RosterEntry } from "#lib/wire/protocol";
import type { JSX } from "solid-js";
import { WorkspaceRow, setMenuOpenId } from "../../../../web/components/fleet/sidebar/WorkspaceRow";
import { rosterEntry } from "../../../fixtures/roster";
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
	session: RosterEntry;
	inProjectGroup?: boolean;
	projectMissing?: boolean;
	/** false for a row of a plain-directory project (no `.git`): no branch, diffstat, or worktree controls. */
	projectGit?: boolean;
}) => (
	<Column>
		<WorkspaceRow
			session={props.session}
			inProjectGroup={props.inProjectGroup}
			projectMissing={props.projectMissing}
			projectGit={props.projectGit}
		/>
	</Column>
);

const LONG_TITLE =
	"Migrate the roster sidebar rows to content height and move the session controls onto the top line";

/** The attached worktree (ready, idle) with a different last-session title. */
const withTitle = (sessionTitle: string | undefined): RosterEntry => ({
	...rosterEntry.worktree,
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
			render: () => <Row session={rosterEntry.worktree} />,
		},
		{
			name: "Working (spinner)",
			description:
				"A detached main checkout mid-turn: the corner spinner, the rail, and the diffstat line because it has local changes.",
			render: () => <Row session={rosterEntry.main} />,
		},
		{
			name: "Pre-existing linked worktree",
			description:
				"Asleep and no session file yet: the dimmed branch, then a muted `New session` title line, no rail.",
			render: () => <Row session={rosterEntry.registeredWorktree} />,
		},
		{
			name: "Worktree in project group",
			render: () => <Row session={rosterEntry.worktree} inProjectGroup />,
		},
		{
			name: "Asleep worktree (dimmed)",
			render: () => <Row session={rosterEntry.asleep} />,
		},
		{
			name: "Asleep worktree with diffstat (muted)",
			description:
				"An asleep row keeps the diffstat it had when it went to sleep, drawn muted: asleep rows are never re-probed, so it stays frozen until the row wakes.",
			render: () => <Row session={rosterEntry.asleepDirty} />,
		},
		{
			name: "Starting (spinner)",
			render: () => <Row session={rosterEntry.starting} />,
		},
		{
			name: "Clone preparing",
			render: () => <Row session={rosterEntry.clonePreparing} />,
		},
		{
			name: "Clone failed",
			render: () => <Row session={rosterEntry.cloneFailed} />,
		},
		{
			name: "Local-source clone, actions menu (Fetch into project)",
			seed: () => setMenuOpenId(rosterEntry.cloneLocal.workspaceId),
			render: () => <Row session={rosterEntry.cloneLocal} />,
		},
		{
			name: "Remote-source clone, actions menu (no fetch action)",
			seed: () => setMenuOpenId(rosterEntry.cloneFailed.workspaceId),
			render: () => <Row session={rosterEntry.cloneFailed} />,
		},
		{
			name: "Unread output (dot)",
			render: () => <Row session={rosterEntry.localactionMain} />,
		},
		{
			name: "Reconnecting (dot)",
			render: () => <Row session={rosterEntry.reconnecting} />,
		},
		{
			name: "Session error (dot)",
			render: () => <Row session={rosterEntry.sessionError} />,
		},
		{
			name: "Blocked (dot)",
			render: () => <Row session={rosterEntry.blocked} />,
		},
		{
			name: "Untitled session (placeholder)",
			description:
				"A ready, idle worktree whose session has messages but no title yet, with no git changes: a muted `Untitled session` line.",
			render: () => (
				<Row
					session={{
						...withTitle(undefined),
						git: { added: 0, modified: 0, deleted: 0, untracked: 0 },
					}}
				/>
			),
		},
		{
			name: "New session, empty session (placeholder)",
			description:
				"A worktree whose session file has no messages (`sessionEmpty`): a muted `New session` line, the same as a row with no session file at all.",
			render: () => (
				<Row
					session={{
						...withTitle(undefined),
						sessionEmpty: true,
						git: { added: 0, modified: 0, deleted: 0, untracked: 0 },
					}}
				/>
			),
		},
		{
			name: "Plain directory row (no git)",
			description:
				"A row of a project with no `.git` (`projectGit` false): no worktree icon, branch, or diffstat; the title leads the single line, and every session action stays.",
			render: () => <Row session={rosterEntry.notesMain} inProjectGroup projectGit={false} />,
		},
		{
			name: "Plain directory row, Untitled session",
			description:
				"Messages but no title: the muted `Untitled session` placeholder is the top line.",
			render: () => <Row session={rosterEntry.journalMain} inProjectGroup projectGit={false} />,
		},
		{
			name: "Plain directory row, New session",
			description:
				"An orphaned worktree row of a project that lost its `.git`, still running with an empty session (the fleet removes it once it stops): it renders as a plain row with a muted `New session`, and offers no Delete worktree.",
			render: () => <Row session={rosterEntry.notesOrphan} projectGit={false} />,
		},
		{
			name: "Long title, one line (default)",
			description: "A long session title clamps to one line with an ellipsis.",
			render: () => <Row session={withTitle(LONG_TITLE)} />,
		},
		{
			name: "Long title, two lines (setting on)",
			description: "With two-line session titles on, a long title takes two lines.",
			seed: { sidebarSessionTitleLines: 2 },
			render: () => <Row session={withTitle(LONG_TITLE)} />,
		},
		{
			name: "Short title, two-line setting on",
			description: "A short title still takes one line; no blank line is reserved.",
			seed: { sidebarSessionTitleLines: 2 },
			render: () => <Row session={withTitle("Fixture modules")} />,
		},
		{
			name: "Title first, with diffstat (setting on)",
			description:
				"The session title leads the top line, flush left; the branch sits in small gray text before the diffstat.",
			seed: { sidebarTitleFirst: true },
			render: () => <Row session={rosterEntry.main} />,
		},
		{
			name: "Title first, long title and branch (setting on)",
			description:
				"Both clamp: the title to one line, the branch with an ellipsis before the diffstat.",
			seed: { sidebarTitleFirst: true },
			render: () => (
				<Row
					session={{
						...rosterEntry.main,
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
					session={{
						...rosterEntry.worktree,
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
			render: () => <Row session={withTitle(undefined)} />,
		},
		{
			name: "Title first, plain directory row (setting on)",
			description:
				"A plain-directory row has no branch, so its title is the top line with the setting on or off.",
			seed: { sidebarTitleFirst: true },
			render: () => <Row session={rosterEntry.journalMain} inProjectGroup projectGit={false} />,
		},
		{
			name: "Long branch name",
			description: "The branch truncates with an ellipsis before the right-hand controls.",
			render: () => (
				<Row
					session={{
						...rosterEntry.worktree,
						branch: "feat/design-fixtures-for-every-sidebar-state-and-more",
					}}
				/>
			),
		},
		{
			name: "Detached worktree",
			render: () => (
				<Row session={{ ...rosterEntry.worktree, branch: undefined, detachedAt: "3f9c2a1" }} />
			),
		},
		{
			name: "Locked worktree",
			render: () => <Row session={{ ...rosterEntry.worktree, worktreeLocked: true }} />,
		},
		{
			name: "Project missing",
			render: () => <Row session={rosterEntry.localactionMain} projectMissing />,
		},
	],
});
