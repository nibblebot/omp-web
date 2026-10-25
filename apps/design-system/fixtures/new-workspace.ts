import type { ProjectBranch } from "#lib/wire/protocol";
import { settleProjectBranches, settleWorkspaceCreate } from "../../web/store/projects";
import { answerCommands } from "../session";
import { rosterProjectBranches } from "./roster";

const REMOTE_BRANCHES: ProjectBranch[] = [
	{ name: "main", checkedOut: false },
	{ name: "feat/remote-cache", checkedOut: false },
	{ name: "fix/clone-ssh", checkedOut: false },
];

/** How the create_worktree / create_clone commands are answered. `hang` leaves the
 *  popover on its progress row; `refuse` answers with the fleet's refusal reason. */
export interface NewWorkspaceAnswers {
	create?: "accept" | "hang" | "refuse";
}

/** Answer list_project_branches and the create commands for the New workspace popover. */
export function answerNewWorkspaceCommands(options: NewWorkspaceAnswers = {}): void {
	const create = options.create ?? "accept";
	answerCommands({
		list_project_branches: (cmd) => {
			if (cmd.type !== "list_project_branches") return;
			if (cmd.remote === undefined) {
				settleProjectBranches({
					projectId: cmd.projectId,
					branches: rosterProjectBranches,
					remotes: ["origin", "upstream"],
					defaultBase: "main",
				});
				return;
			}
			settleProjectBranches({
				projectId: cmd.projectId,
				remote: cmd.remote,
				branches: REMOTE_BRANCHES,
				remotes: ["origin", "upstream"],
				defaultBase: "main",
				cached: true,
			});
		},
		create_worktree: (cmd) => {
			if (cmd.type !== "create_worktree" || create === "hang") return;
			if (create === "refuse") {
				settleWorkspaceCreate({
					id: cmd.id,
					ok: false,
					error: `branch ${cmd.existingBranch ?? cmd.name} is already checked out`,
				});
				return;
			}
			settleWorkspaceCreate({ id: cmd.id, ok: true, workspaceId: "dmn_new_worktree" });
		},
		create_clone: (cmd) => {
			if (cmd.type !== "create_clone" || create === "hang") return;
			if (create === "refuse") {
				settleWorkspaceCreate({
					id: cmd.id,
					ok: false,
					error: "project has no origin remote",
				});
				return;
			}
			settleWorkspaceCreate({ id: cmd.id, ok: true, workspaceId: "dmn_new_clone" });
		},
	});
}
