import type { ProjectBranch, RosterEntry } from "#lib/wire/protocol";
import { state } from "../../web/state";
import { settleProjectBranches, settleWorkspaceCreate } from "../../web/store/projects";
import { answerCommands, type CommandHandlers } from "../session";
import { upsertRosterEntry } from "./command-bus";
import { rosterProjectBranches } from "./roster";

const REMOTE_BRANCHES: ProjectBranch[] = [
	{ name: "main", checkedOut: false },
	{ name: "feat/remote-cache", checkedOut: false },
	{ name: "fix/clone-ssh", checkedOut: false },
];

/**
 * A project's local branches as the fleet lists them: omp-web's from the fixture, any other
 * project's main plus its rows' branches. A branch is checked out where a local roster row has it.
 */
function projectBranches(projectId: string): ProjectBranch[] {
	const rows = state.sessionRoster.filter(
		(row) => row.projectId === projectId && row.workspaceKind !== "clone",
	);
	const names =
		projectId === "proj_omp_web"
			? rosterProjectBranches.map((branch) => branch.name)
			: [...new Set(["main", ...rows.flatMap((row) => (row.branch ? [row.branch] : []))])];
	return names.map((name) => {
		const row = rows.find((entry) => entry.branch === name);
		return row ? { name, checkedOut: true, worktreePath: row.cwd } : { name, checkedOut: false };
	});
}

/** How the create_worktree / create_clone commands are answered. `hang` leaves the
 *  popover on its progress row; `refuse` answers with the fleet's refusal reason.
 *  `start` also brings the new workspace onto the roster, connecting and then ready,
 *  as the fleet's roster broadcasts do, so the popover goes on to attach (the App demo). */
export interface NewWorkspaceAnswers {
	create?: "accept" | "hang" | "refuse";
	start?: boolean;
}

/** How long a started workspace's session process takes to come up. */
const START_MS = 900;

/** Put a new workspace on the fleet's roster as connecting, then ready once its session process is up. */
function startWorkspace(row: RosterEntry): void {
	upsertRosterEntry(row);
	setTimeout(() => {
		upsertRosterEntry({
			...row,
			status: "ready",
			lifecycleStage: row.workspaceKind === "clone" ? "ready" : undefined,
			readyAt: Date.now(),
			uptime: 0,
		});
	}, START_MS);
}

/** The list_project_branches and create command handlers of the New workspace popover. */
export function newWorkspaceCommands(options: NewWorkspaceAnswers = {}): CommandHandlers {
	const create = options.create ?? "accept";
	let created = 0;
	return {
		list_project_branches: (cmd) => {
			if (cmd.type !== "list_project_branches") return;
			if (cmd.remote === undefined) {
				settleProjectBranches({
					projectId: cmd.projectId,
					branches: projectBranches(cmd.projectId),
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
			const workspaceId = options.start ? `dmn_new_worktree_${++created}` : "dmn_new_worktree";
			const project = state.registeredProjects.find((p) => p.projectId === cmd.projectId);
			if (options.start && project !== undefined) {
				const branch = cmd.existingBranch ?? cmd.name;
				const folder = branch.replaceAll("/", "-");
				startWorkspace({
					workspaceId,
					name: folder,
					cwd: `${project.path}-worktrees/${folder}`,
					project: project.name,
					projectId: project.projectId,
					worktreeOf: project.path,
					branch,
					git: { added: 0, modified: 0, deleted: 0, untracked: 0 },
					status: "connecting",
					sessionEmpty: true,
					workspaceKind: "worktree",
					desiredState: "running",
				});
			}
			settleWorkspaceCreate({ id: cmd.id, ok: true, workspaceId });
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
			const workspaceId = options.start ? `dmn_new_clone_${++created}` : "dmn_new_clone";
			const project = state.registeredProjects.find((p) => p.projectId === cmd.projectId);
			if (options.start && project !== undefined) {
				startWorkspace({
					workspaceId,
					name: cmd.name,
					cwd: `/home/joshua/.omp/clones/${cmd.name}`,
					project: project.name,
					projectId: project.projectId,
					branch: cmd.branch ?? cmd.name,
					status: "connecting",
					sessionEmpty: true,
					providerProfileId: cmd.profileId,
					workspaceKind: "clone",
					desiredState: "running",
					lifecycleStage: "runtime",
				});
			}
			settleWorkspaceCreate({ id: cmd.id, ok: true, workspaceId });
		},
	};
}

/** Answer list_project_branches and the create commands for the New workspace popover. */
export function answerNewWorkspaceCommands(options: NewWorkspaceAnswers = {}): void {
	answerCommands(newWorkspaceCommands(options));
}
