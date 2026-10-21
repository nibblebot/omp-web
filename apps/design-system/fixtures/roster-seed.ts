import { markUnread, pruneUnread } from "../../web/fleet-ui/unread";
import { setState, type state } from "../../web/state";
import { settleAddProject } from "../../web/store/projects";
import { type CommandHandlers, answerCommands } from "../daemon";
import { rosterFleetState, rosterProjects } from "./roster";
import { rosterFsBrowse } from "./roster-routes";

/**
 * Project commands the sidebar and the Add project dialog send. A registered
 * path answers `existing`; a path the fixture browser can list registers a new
 * project; any other path is refused. remove_project and sync_projects change
 * nothing, so the seeded roster stays as it is.
 */
const projectCommands: CommandHandlers = {
	add_project: (cmd) => {
		if (cmd.type !== "add_project") return;
		const registered = rosterProjects.find((project) => project.path === cmd.path);
		if (registered) {
			settleAddProject({ id: cmd.id, ok: true, projectId: registered.projectId, existing: true });
			return;
		}
		if (rosterFsBrowse(cmd.path) instanceof Response) {
			settleAddProject({ id: cmd.id, ok: false, error: `${cmd.path} is not a git repository` });
			return;
		}
		const name = cmd.path.split("/").pop() ?? cmd.path;
		settleAddProject({ id: cmd.id, ok: true, projectId: `proj_${name}`, existing: false });
	},
	remove_project: () => {},
	sync_projects: () => {},
};

/**
 * Function seed for roster stories: resets the module-level unread set (it
 * lives outside the store), marks the transport connected (daemon.ts), applies
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
