import { daemonsKey, type JobTreeDto, type JobTreeRowDto } from "#lib/wire/protocol";
import { setState, state } from "../../web/state";
import { refreshJobTree } from "../../web/store/job-poll";
import { addCalls } from "../session";
import { seedDaemons, seedTodos, todoPhasesDone, todoPhasesMidRun } from "./activities";
import { jobCalls, jobTreeFixture } from "./jobs";
import { agentTreeInfos, seedAgentTree } from "./subagents";

/** The workspace the roster fixtures report the daemons for; the job poll asks for the one that is selected. */
const WORKSPACE_ID = "dmn_a002";

/** Which parts of the session the activity bar's buttons read, and in what state. */
export interface ActivityBarParts {
	subagents?: "running" | "settled";
	/** `overflow`: more finished jobs than a popover lists. */
	jobs?: "running" | "settled" | "overflow";
	daemons?: boolean;
	todos?: "mid-run" | "done";
}

/** The job tree for a state of the jobs: as the session reports it, nothing running, or with extra finished jobs. */
function jobTreeOf(kind: "running" | "settled" | "overflow"): JobTreeDto {
	const tree = jobTreeFixture();
	if (kind === "running") return tree;
	if (kind === "settled") {
		return {
			...tree,
			rows: tree.rows.map((row) =>
				row.kind === "job" && row.job.status === "running"
					? { ...row, job: { ...row.job, status: "completed", endTime: Date.now() } }
					: row,
			),
		};
	}
	const now = Date.now();
	const extra: JobTreeRowDto[] = Array.from({ length: 6 }, (_, i) => ({
		kind: "job",
		job: {
			id: `job_extra_${i + 1}`,
			type: "bash",
			status: "completed",
			label: `bun run lint --shard ${i + 1}`,
			startTime: now - (20 + i) * 60_000,
			endTime: now - (19 + i) * 60_000,
			ownerId: tree.rootId,
			own: true,
		},
		depth: 0,
		rails: [],
		last: true,
		parent: false,
	}));
	return { ...tree, rows: [...tree.rows, ...extra] };
}

/**
 * Seed the session the activity bar reads: any mix of subagents, jobs, daemons and todos, each
 * through the real store actions. A part left out is absent, so its button is too. The job calls are
 * installed before the workspace is selected, so the poll that selecting it starts gets the tree.
 */
export function seedActivityBar(parts: ActivityBarParts = {}): void {
	if (parts.subagents !== undefined)
		seedAgentTree({ display: true, settled: parts.subagents === "settled" });
	if (parts.jobs !== undefined) addCalls(jobCalls({ tree: jobTreeOf(parts.jobs) }));
	if (parts.daemons === true) seedDaemons();
	else setState({ currentWorkspaceId: WORKSPACE_ID });
	// After the stage's own reset has rejected the poll a previous seed left in flight (a refresh would join it and fail with it).
	if (parts.jobs !== undefined) setTimeout(() => void refreshJobTree(), 0);
	if (parts.todos !== undefined)
		seedTodos(parts.todos === "done" ? todoPhasesDone : todoPhasesMidRun);
}

/** Enough extra subagents that the popover's cap leaves "+N more". Call after `seedActivityBar`. */
export function addSubagentOverflow(count = 6): void {
	const base = agentTreeInfos.find((info) => info.id === "FixtureBuilder");
	if (base === undefined) throw new Error("missing FixtureBuilder fixture");
	setState("subagents", (current) => {
		const next = new Map(current);
		for (let i = 1; i <= count; i++) {
			const id = `Shard-${i}`;
			next.set(id, {
				...base,
				id,
				index: 100 + i,
				description: `Sweep shard ${i} of the docs`,
				status: "completed",
			});
		}
		return next;
	});
}

/** Extra live daemons so the popover's cap leaves "+N more". Call after `seedDaemons`. */
export function addDaemonOverflow(count = 7): void {
	const base = [...state.daemons.values()].find((d) => d.name === "vite-dev");
	if (base === undefined) throw new Error("missing vite-dev daemon fixture");
	setState("daemons", (current) => {
		const next = new Map(current);
		for (let i = 1; i <= count; i++) {
			const info = { ...base, id: `dmn_x${i}`, name: `worker-${i}`, readyPort: 7000 + i };
			next.set(daemonsKey(info), info);
		}
		return next;
	});
}

/** A board with more tasks than the popover's cap. */
export function seedTodoOverflow(): void {
	seedTodos([
		...todoPhasesMidRun,
		{
			name: "Release",
			tasks: Array.from({ length: 6 }, (_, i) => ({
				content: `Release step ${i + 1}`,
				status: "pending" as const,
			})),
		},
	]);
}
