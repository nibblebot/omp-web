import { daemonsKey } from "#lib/wire/protocol";
import { setState, state } from "../../web/state";
import { settleDaemonControl, settleDaemonLogs } from "../../web/store/transport";
import { answerCommands, type CommandHandlers } from "../session";
import { rosterDaemonInfos } from "./roster";

/** Daemons and todos of the Activities panel, for the workspace the roster fixtures select (`dmn_a002`). */

const WORKSPACE_ID = "dmn_a002";

const LOGS: Record<string, string[]> = {
	"vite-dev": [
		"  VITE v7.1.2  ready in 412 ms",
		"  ➜  Local:   http://127.0.0.1:5173/",
		"10:02:11 [vite] page reload apps/web/App.tsx",
		"10:04:37 [vite] hmr update /components/activities/DaemonsSection.tsx",
		"10:04:52 [vite] hmr update /styles/activities.css",
	],
	"design-server": [
		"design server listening on 127.0.0.1:4799",
		"GET /stories/activities-daemons-section 200 4ms",
		"GET /stories/activities-todos-section 200 3ms",
	],
	"fleet-edge": [],
};

function logText(name: string): string {
	return (LOGS[name] ?? [`${name}: started`]).join("\n");
}

/**
 * What the Daemons section sends, answered like the fleet answers it: the log tail of a row,
 * restart (a fresh run of the same process) and kill (the process exits and leaves the list).
 * `logs` overrides the answer for a daemon name: a string is its tail, `Error` fails the fetch.
 */
export function daemonCommands(logs: Record<string, string | Error> = {}): CommandHandlers {
	const find = (name: string) => [...state.daemons.values()].find((d) => d.name === name);
	return {
		daemon_logs: (cmd) => {
			if (cmd.type !== "daemon_logs") return;
			const override = logs[cmd.name];
			if (override instanceof Error) {
				settleDaemonLogs({
					type: "daemon_logs_result",
					id: cmd.id,
					ok: false,
					error: override.message,
				});
				return;
			}
			settleDaemonLogs({
				type: "daemon_logs_result",
				id: cmd.id,
				ok: true,
				text: override ?? logText(cmd.name),
				cursor: 0,
				state: find(cmd.name)?.state ?? "running",
			});
		},
		daemon_restart: (cmd) => {
			const daemon = cmd.type === "daemon_restart" ? find(cmd.name) : undefined;
			if (daemon === undefined) return;
			settleDaemonControl({
				type: "daemon_control_result",
				id: cmd.id,
				ok: true,
				daemon: {
					...daemon,
					state: "running",
					startedAt: Date.now(),
					restartCount: daemon.restartCount + 1,
				},
			});
		},
		daemon_stop: (cmd) => {
			const daemon = cmd.type === "daemon_stop" ? find(cmd.name) : undefined;
			if (daemon === undefined) return;
			settleDaemonControl({
				type: "daemon_control_result",
				id: cmd.id,
				ok: true,
				daemon: { ...daemon, state: "exited", exitedAt: Date.now(), exitCode: 0 },
			});
		},
	};
}

/** The selected workspace's daemons (the roster's `bench-runner` belongs to another workspace and `docs-watch` has exited, so the section lists three), answered like the fleet answers them. */
export function seedDaemons(logs: Record<string, string | Error> = {}): void {
	setState({ currentWorkspaceId: WORKSPACE_ID, ...daemonsPatch() });
	answerCommands(daemonCommands(logs));
}

/** The store patch that lists the fixture daemons as a `daemons` frame would. */
export function daemonsPatch(): Pick<typeof state, "daemons" | "daemonsLoaded"> {
	const now = Date.now();
	return {
		daemons: new Map(rosterDaemonInfos(now).map((info) => [daemonsKey(info), info])),
		daemonsLoaded: true,
	};
}

/** A board mid-run: one phase finished, one underway, one waiting; every status the checklist shows. */
export const todoPhasesMidRun: typeof state.todoPhases = [
	{
		name: "Foundations",
		tasks: [
			{ content: "Add the activities store", status: "completed" },
			{ content: "Summaries over the live stores", status: "completed" },
			{ content: "Drop the legacy jobs bar", status: "abandoned" },
		],
	},
	{
		name: "Sections",
		tasks: [
			{ content: "Daemons section with log expand", status: "in_progress" },
			{ content: "Todo section, read-only", status: "pending" },
			{ content: "Wire the activity bar popovers", status: "pending" },
		],
	},
	{
		name: "Wrap up",
		tasks: [{ content: "Changelog and design stories", status: "pending" }],
	},
];

/** Every task of the board done. */
export const todoPhasesDone: typeof state.todoPhases = todoPhasesMidRun.map((phase) => ({
	...phase,
	tasks: phase.tasks.map((task) => ({ ...task, status: "completed" as const })),
}));

/** Seed the board the checklist reads. */
export function seedTodos(phases: typeof state.todoPhases = todoPhasesMidRun): void {
	setState({ todoPhases: structuredClone(phases) });
}

/** Move the live board one step: the underway task completes and the next pending one starts. */
export function advanceTodos(): void {
	const tasks = state.todoPhases.flatMap((phase) => phase.tasks);
	const current = tasks.find((task) => task.status === "in_progress")?.content;
	const next = tasks.find((task) => task.status === "pending")?.content;
	setState("todoPhases", (phases) =>
		phases.map((phase) => ({
			...phase,
			tasks: phase.tasks.map((task) => {
				if (task.content === current) return { ...task, status: "completed" as const };
				if (task.content === next && current !== undefined) {
					return { ...task, status: "in_progress" as const };
				}
				return task;
			}),
		})),
	);
}
