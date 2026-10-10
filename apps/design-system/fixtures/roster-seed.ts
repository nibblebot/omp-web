import { markUnread, pruneUnread } from "../../web/fleet-ui/unread";
import { setState, type state } from "../../web/state";
import { settleProjectBranches, settleProjects } from "../../web/store/projects";
import { answerCommands } from "../daemon";
import { rosterFleetState, rosterProjectBranches, rosterProjectEntries } from "./roster";

/**
 * Function seed for roster stories: resets the module-level unread set (it
 * lives outside the store), answers the list_projects and
 * list_project_branches commands pickers send on mount (daemon.ts, which also
 * marks the transport connected), applies `rosterFleetState` with `extra` on
 * top, and marks the finished-while-away session unread. Browser-only: kept
 * out of roster.ts, whose data the design server also loads.
 */
export function seedRosterFleet(extra: Partial<typeof state> = {}): void {
	pruneUnread(new Set());
	answerCommands({
		list_projects: () => settleProjects(rosterProjectEntries),
		list_project_branches: (cmd) => {
			if (cmd.type === "list_project_branches") {
				settleProjectBranches(cmd.projectId, rosterProjectBranches);
			}
		},
	});
	setState({ ...structuredClone(rosterFleetState), ...structuredClone(extra) });
	markUnread("dmn_b001");
}
