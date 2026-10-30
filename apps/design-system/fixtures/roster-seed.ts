import {
	workspaceSessionsLimit,
	type RegisteredProject,
	type SessionListEntry,
} from "#lib/wire/protocol";
import { markUnread, pruneUnread } from "../../web/fleet-ui/unread";
import { setState, state } from "../../web/state";
import { settleAddProject } from "../../web/store/projects";
import { settleWorkspaceSessions } from "../../web/store/roster";
import { type CommandHandlers, answerCommands } from "../session";
import { rosterFleetState } from "./roster";
import { rosterFsBrowse } from "./roster-routes";

/**
 * Project commands the sidebar and the Add project dialog send. A registered
 * path answers `existing`; any directory the fixture browser can list registers a new
 * project, git or not, and shows up in the sidebar as the fleet's registered_projects
 * frame would show it; any other path is refused as not a directory. remove_project
 * and sync_projects change nothing, so the seeded roster stays as it is.
 */
export const projectCommands: CommandHandlers = {
	add_project: (cmd) => {
		if (cmd.type !== "add_project") return;
		const registered = state.registeredProjects.find((project) => project.path === cmd.path);
		if (registered) {
			settleAddProject({ id: cmd.id, ok: true, projectId: registered.projectId, existing: true });
			return;
		}
		if (rosterFsBrowse(cmd.path) instanceof Response) {
			settleAddProject({ id: cmd.id, ok: false, error: `not a directory: ${cmd.path}` });
			return;
		}
		const parent = rosterFsBrowse(cmd.path.slice(0, cmd.path.lastIndexOf("/")));
		const listed = parent instanceof Response ? undefined : parent.dirs;
		const git = listed?.find((dir) => dir.path === cmd.path)?.hasGit === true;
		const name = cmd.path.split("/").pop() ?? cmd.path;
		const project: RegisteredProject = {
			projectId: `proj_${name}`,
			path: cmd.path,
			name,
			addedAt: Date.now(),
			...(git ? {} : { git: false }),
		};
		setState("registeredProjects", (projects) => [...projects, project]);
		settleAddProject({ id: cmd.id, ok: true, projectId: project.projectId, existing: false });
	},
	remove_project: () => {},
	sync_projects: () => {},
};

/**
 * Function seed for roster stories: resets the module-level unread set (it
 * lives outside the store), marks the transport connected (session.ts), applies
 * `rosterFleetState` with `extra` on
 * top, and marks the finished-while-away session unread. `commands` adds story
 * answers for further command types (the sidebar story answers delete_worktree). Browser-only: kept
 * out of roster.ts, whose data the design server also loads.
 */
export function seedRosterFleet(
	extra: Partial<typeof state> = {},
	commands: CommandHandlers = {},
): void {
	pruneUnread(new Set());
	answerCommands({ ...projectCommands, ...commands });
	setState({ ...structuredClone(rosterFleetState), ...structuredClone(extra) });
	markUnread("dmn_b001");
}

/**
 * seedRosterFleet plus a `list_workspace_sessions` answer for any session: `sessions()`
 * cut to the request's limit, as the fleet does (the worktree dialog asks for 200).
 * `null` never answers, so the list stays loading.
 */
export function seedRosterSessions(
	sessions: () => SessionListEntry[] | null,
	extra: Partial<typeof state> = {},
): void {
	seedRosterFleet(extra, {
		list_workspace_sessions: (cmd) => {
			const list = sessions();
			if (cmd.type !== "list_workspace_sessions" || list === null) return;
			settleWorkspaceSessions(
				cmd.workspaceId,
				list.slice(0, workspaceSessionsLimit(cmd.limit)),
				cmd.limit,
			);
		},
	});
}
