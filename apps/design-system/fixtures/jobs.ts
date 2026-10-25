import { glanceJobWidgetView } from "#lib/wire/job-widget";
import type {
	JobAgentDto,
	JobDetailDto,
	JobDto,
	JobStatus,
	JobTreeDto,
	JobTreeRowDto,
	WireJobWidgetView,
} from "#lib/wire/protocol";
import { refreshJobTree } from "../../web/store/job-poll";
import { addCalls, type CallHandlers } from "../session";
import { authoringWidget, benchWidget, blockWidgets, subagentWidget } from "./job-widgets";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const ROOT = "Main";

/** One node of a hand-written tree: a job (a task job heads its subagent) or a subagent header, and what nests under it. */
interface TreeNode {
	row:
		| { kind: "job"; job: JobDto; agent?: JobAgentDto; widget?: WireJobWidgetView }
		| { kind: "agent"; agent: JobAgentDto };
	children?: TreeNode[];
}

/** Rows in display order with their places, as the session's `buildJobTree` hands them out (depth first, rails continue past non-last siblings). */
function flatten(
	nodes: readonly TreeNode[],
	depth = 0,
	rails: readonly boolean[] = [],
): JobTreeRowDto[] {
	return nodes.flatMap((node, index) => {
		const last = index === nodes.length - 1;
		const children = node.children ?? [];
		const place = { depth, rails: [...rails], last, parent: children.length > 0 };
		return [
			{ ...node.row, ...place } as JobTreeRowDto,
			...flatten(children, depth + 1, depth === 0 ? [] : [...rails, !last]),
		];
	});
}

function job(
	id: string,
	type: string,
	label: string,
	status: JobStatus,
	startedAgo: number,
	options: { ranFor?: number; ownerId?: string; agentId?: string; now: number },
): JobDto {
	const ownerId = options.ownerId ?? ROOT;
	return {
		id,
		type,
		status,
		label,
		startTime: options.now - startedAgo,
		...(status === "running"
			? {}
			: { endTime: options.now - startedAgo + (options.ranFor ?? 5 * SECOND) }),
		...(options.agentId === undefined ? {} : { agentId: options.agentId }),
		ownerId,
		own: ownerId === ROOT,
	};
}

/** Ids the stories and their handlers refer to. */
export const JOB_IDS = {
	explore: "job_explore",
	nestedTests: "job_auth_tests",
	reader: "job_reader",
	readerSearch: "job_reader_rg",
	devServer: "job_dev",
	build: "job_build",
	tests: "job_tests",
	tail: "job_tail",
	reviewDiff: "job_review_diff",
} as const;

/** The widget each job has: a spec-driven benchmark, a subagent's plan, a dev command still being authored, a finished run. */
const WIDGET_BY_JOB: Readonly<Record<string, WireJobWidgetView>> = {
	[JOB_IDS.devServer]: benchWidget,
	[JOB_IDS.explore]: subagentWidget,
	[JOB_IDS.nestedTests]: authoringWidget,
	[JOB_IDS.tests]: blockWidgets.meter,
};

/** A running job's row carries its widget cut to a glance, as the session's `getJobTree` sends it. */
const withRowWidgets = (rows: JobTreeRowDto[]): JobTreeRowDto[] =>
	rows.map((row) => {
		const view =
			row.kind === "job" && row.job.status === "running" ? WIDGET_BY_JOB[row.job.id] : undefined;
		return row.kind === "job" && view ? { ...row, widget: glanceJobWidgetView(view) } : row;
	});

/** The job tree of a session whose subagents run their own background jobs; times are relative to `now`. */
export function jobTreeFixture(now = Date.now()): JobTreeDto {
	const explorer: JobAgentDto = { id: "Explorer", parentId: ROOT };
	const reader: JobAgentDto = { id: "Explorer.Reader", parentId: "Explorer" };
	const reviewer: JobAgentDto = { id: "Reviewer", parentId: ROOT };
	const opts = { now };
	return {
		rootId: ROOT,
		rows: withRowWidgets(
			flatten([
				{
					row: {
						kind: "job",
						agent: explorer,
						job: job(JOB_IDS.explore, "task", "Explore the auth module", "running", 134 * SECOND, {
							...opts,
							agentId: "Explorer",
						}),
					},
					children: [
						{
							row: {
								kind: "job",
								agent: reader,
								job: job(JOB_IDS.reader, "task", "Read the session store", "running", 96 * SECOND, {
									...opts,
									ownerId: "Explorer",
									agentId: "Explorer.Reader",
								}),
							},
							children: [
								{
									row: {
										kind: "job",
										job: job(
											JOB_IDS.readerSearch,
											"bash",
											"rg -n 'token' src/auth",
											"completed",
											80 * SECOND,
											{ ...opts, ownerId: "Explorer.Reader", ranFor: 2 * SECOND },
										),
									},
								},
							],
						},
						{
							row: {
								kind: "job",
								job: job(
									JOB_IDS.nestedTests,
									"bash",
									"bun test apps/auth --watch",
									"running",
									112 * SECOND,
									{ ...opts, ownerId: "Explorer" },
								),
							},
						},
					],
				},
				{
					row: { kind: "agent", agent: reviewer },
					children: [
						{
							row: {
								kind: "job",
								job: job(
									JOB_IDS.reviewDiff,
									"bash",
									"git diff --stat main...HEAD",
									"completed",
									5 * MINUTE,
									{
										...opts,
										ownerId: "Reviewer",
										ranFor: 900,
									},
								),
							},
						},
					],
				},
				{
					row: {
						kind: "job",
						job: job(
							JOB_IDS.devServer,
							"bash",
							"bun run dev",
							"running",
							14 * MINUTE + 2 * SECOND,
							opts,
						),
					},
				},
				{
					row: {
						kind: "job",
						job: job(JOB_IDS.tail, "bash", "tail -f /var/log/app.log", "cancelled", 9 * MINUTE, {
							...opts,
							ranFor: 7 * MINUTE,
						}),
					},
				},
				{
					row: {
						kind: "job",
						job: job(JOB_IDS.tests, "bash", "bun test", "completed", 6 * MINUTE, {
							...opts,
							ranFor: 73 * SECOND,
						}),
					},
				},
				{
					row: {
						kind: "job",
						job: job(JOB_IDS.build, "bash", "make build", "failed", 3 * MINUTE, {
							...opts,
							ranFor: 41 * SECOND,
						}),
					},
				},
			]),
		),
	};
}

/** The inspection of each job of `jobTreeFixture`. */
export const jobDetails: Readonly<Record<string, JobDetailDto>> = {
	[JOB_IDS.explore]: {
		widget: subagentWidget,
		pids: [],
		output: "Reading apps/auth/session.ts\nTracing token refresh through the middleware chain\n",
	},
	[JOB_IDS.nestedTests]: {
		widget: authoringWidget,
		command: "bun test apps/auth --watch",
		cwd: "/home/joshua/Repos/omp-web",
		pids: [48211, 48219],
		output:
			"apps/auth/session.test.ts:\n(pass) refresh keeps the cookie [4.1ms]\n(pass) expired token is rejected [1.3ms]\n\nWatching for file changes...\n",
	},
	[JOB_IDS.devServer]: {
		widget: benchWidget,
		command: "bun run dev",
		cwd: "/home/joshua/Repos/omp-web",
		pids: [47902],
		output:
			"$ vite --host\n  VITE v7.1.2  ready in 412 ms\n  Local:   http://localhost:5173/\n  Network: use --host to expose\n",
	},
	[JOB_IDS.build]: {
		command: "make build",
		cwd: "/home/joshua/Repos/omp-web",
		pids: [],
		exitCode: 2,
		output:
			"cc -o build/app src/main.c\nsrc/main.c:41: error: 'token_t' undeclared\nmake: *** [build] Error 1\n",
	},
	[JOB_IDS.tests]: {
		widget: blockWidgets.meter,
		command: "bun test",
		cwd: "/home/joshua/Repos/omp-web",
		pids: [],
		exitCode: 0,
		output: "412 pass\n0 fail\nRan 412 tests across 58 files. [73.00s]\n",
		outputTruncated: true,
		artifactId: "art_9f21",
	},
	[JOB_IDS.tail]: {
		command: "tail -f /var/log/app.log",
		cwd: "/var/log",
		pids: [],
		output: "(cancelled)",
	},
};

export interface JobCallOptions {
	tree?: JobTreeDto;
	/** The session runs no async jobs: `getJobTree` answers null. */
	unavailable?: boolean;
	loadError?: string;
	pending?: boolean;
	/** Cancel answers this refusal instead of stopping the job. */
	cancelError?: string;
}

/** Job methods over a mutable copy of the tree: Cancel settles an own running job as the session does, and refuses any other. */
export function jobCalls(options: JobCallOptions = {}): CallHandlers {
	const tree = structuredClone(options.tree ?? jobTreeFixture());
	const find = (id: unknown) =>
		tree.rows.flatMap((row) => (row.kind === "job" ? [row.job] : [])).find((j) => j.id === id);
	return {
		getJobTree: () => {
			if (options.pending) return Promise.withResolvers<never>().promise;
			if (options.loadError !== undefined) throw new Error(options.loadError);
			return options.unavailable ? null : structuredClone(tree);
		},
		getJobDetail: (args) => {
			const found = find(args[0]);
			return found === undefined ? null : structuredClone(jobDetails[found.id] ?? { pids: [] });
		},
		cancelJob: (args) => {
			if (options.cancelError !== undefined) throw new Error(options.cancelError);
			const found = find(args[0]);
			if (found === undefined)
				throw new Error(`No background job ${String(args[0])} in this session`);
			if (!found.own)
				throw new Error(
					`Job ${found.id} belongs to ${found.ownerId}; only this session's own jobs can be cancelled`,
				);
			if (found.status !== "running") return { cancelled: false };
			found.status = "cancelled";
			found.endTime = Date.now();
			return { cancelled: true };
		},
	};
}

/**
 * Answer the job calls beside the handlers a story already installed and ask for the tree now, as the
 * app does when a workspace attaches (the shared poll then keeps it fresh). The workspace must be set.
 */
export function seedJobs(options: JobCallOptions = {}): void {
	addCalls(jobCalls(options));
	// Seeds run in one batch that may re-run (a variant re-seeds); ask once they have settled, so the
	// call meets the final handlers and not a set a later reset clears.
	setTimeout(() => void refreshJobTree(), 0);
}
