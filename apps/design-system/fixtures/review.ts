import type {
	GitPathEntry,
	GitStatusDto,
	PlanReviewDto,
	ReviewAnnotationDto,
	TodoBoardDto,
} from "#lib/wire/protocol";
import type { GitReviewDiff, TodoReviewOp } from "../../web/store/slices/review";
import type { CallHandlers } from "../session";
import { FIXTURE_NOW } from "./session";

const T0 = Date.parse("2026-10-09T10:00:00Z");
const MIN = 60_000;
const REPO = "/home/joshua/Repos/omp-web";
const BASE_SHA = "9c41e2d7a0b3f58c1e6d4a20b7f9e3c5d8a1b2c4";
const HEAD_SHA = "4f8b0a6e3d2c91f7a5b8e0d4c6a2f1b9e7d3c5a8";

/** GitStatusDto: ReviewPanel for a worktree with staged, unstaged, and untracked paths. */
export const reviewGitStatus: GitStatusDto = {
	available: true,
	cwd: REPO,
	branch: "feat/design-fixtures",
	clean: false,
	indexFingerprint: "idx_3a91",
	worktreeFingerprint: "wt_77c0",
	eligible: { stage: true, commit: true },
	unstaged: [
		{ path: "apps/design-system/fixtures/chat.ts", kind: "untracked" },
		{ path: "apps/design-system/fixtures/roster.ts", kind: "untracked" },
		{ path: "apps/web/components/ui/CopyButton.tsx", kind: "modified" },
	],
	staged: [
		{ path: "apps/web/store/review.ts", kind: "modified" },
		{ path: "apps/web/chat/tool-runs.ts", origPath: "apps/web/chat/runs.ts", kind: "renamed" },
	],
	head: {
		sha: HEAD_SHA,
		shortSha: HEAD_SHA.slice(0, 7),
		subject: "web: group review annotations by anchor kind",
		authorName: "Joshua",
		authorEmail: "joshua@example.dev",
		authorDate: "2026-10-09T08:12:40+00:00",
	},
};

/** GitStatusDto variant: a worktree with build output and vendored paths, 2000 untracked rows and 100 staged ones, for ReviewPanel list windowing. */
export const reviewGitStatusLarge: GitStatusDto = {
	...reviewGitStatus,
	indexFingerprint: "idx_large",
	worktreeFingerprint: "wt_large",
	unstaged: Array.from({ length: 2000 }, (_, index): GitPathEntry => {
		const name = String(index).padStart(4, "0");
		return { path: `vendor/generated/chunk-${name}.js`, kind: "untracked" };
	}),
	staged: Array.from({ length: 100 }, (_, index): GitPathEntry => {
		const name = String(index).padStart(3, "0");
		return { path: `apps/web/generated/schema-${name}.ts`, kind: "added" };
	}),
};

/** GitStatusDto variant: no repository available, so ReviewPanel shows the reason row. */
export const reviewGitStatusUnavailable: GitStatusDto = {
	available: false,
	reason: "not a git repository",
	cwd: "/home/joshua/Downloads",
	branch: null,
	clean: true,
	indexFingerprint: "idx_none",
	worktreeFingerprint: "wt_none",
	eligible: { stage: false, commit: false, reason: "no repository" },
	unstaged: [],
	staged: [],
	head: null,
};

/** GitReviewDiff: a single-hunk diff of CopyButton.tsx for the diff viewer. */
export const reviewGitDiff: GitReviewDiff = {
	path: "apps/web/components/ui/CopyButton.tsx",
	area: "unstaged",
	oldText:
		'export const CopyButton = (props) => {\n\tconst label = copied() ? "copied" : "copy";\n',
	newText:
		'export const CopyButton = (props) => {\n\tconst label = copied() ? "copied" : failed() ? "failed" : "copy";\n',
	binary: false,
	tooLarge: false,
	fingerprint: "idx_3a91",
	truncated: false,
	patch: [
		"--- a/apps/web/components/ui/CopyButton.tsx",
		"+++ b/apps/web/components/ui/CopyButton.tsx",
		"@@ -5,2 +5,2 @@",
		" export const CopyButton = (props) => {",
		'-\tconst label = copied() ? "copied" : "copy";',
		'+\tconst label = copied() ? "copied" : failed() ? "failed" : "copy";',
	].join("\n"),
	hunks: [
		{
			index: 0,
			header: "@@ -5,2 +5,2 @@",
			text: '-\tconst label = copied() ? "copied" : "copy";\n+\tconst label = copied() ? "copied" : failed() ? "failed" : "copy";',
		},
	],
};

/** GitReviewDiff variant: binary asset in the staged area, so the viewer shows the binary placeholder. */
export const reviewGitDiffBinary: GitReviewDiff = {
	path: "apps/design-system/public/fonts/mono.woff2",
	area: "staged",
	binary: true,
	tooLarge: false,
	fingerprint: "idx_3a91",
	hunks: [],
};

/** PlanReviewDto: a waiting plan with the current version and one annotation count in the header. */
export const reviewPlan: PlanReviewDto = {
	reviewId: "plan_rv_12",
	planFilePath: "/home/joshua/.omp/plans/design-fixtures.md",
	title: "Design-system fixture modules",
	content:
		"# Design-system fixture modules\n\n1. Export one typed fixture per DTO.\n2. Keep stories on the shared seed.\n\n- No live session in stories.",
	contentHash: "h_5e21",
	version: 3,
	status: "waiting",
};

/** PlanReviewDto variant: the plan that was sent back with requested changes. */
export const reviewPlanChangesRequested: PlanReviewDto = {
	reviewId: "plan_rv_11",
	planFilePath: "/home/joshua/.omp/plans/review-anchors.md",
	title: "Review anchor migration",
	content:
		"# Review anchor migration\n\n1. Move anchors to content hashes.\n2. Orphan removed entries.",
	contentHash: "h_19ab",
	version: 2,
	status: "changes_requested",
};

/** ReviewAnnotationDto list: one annotation per anchor kind, one stale and one orphaned, for AnnotationsPanel. */
export const reviewAnnotations: ReviewAnnotationDto[] = [
	{
		id: "ann_1",
		author: "operator",
		source: "diff",
		anchor: {
			kind: "diff",
			repositoryId: "repo_omp",
			base: BASE_SHA,
			head: HEAD_SHA,
			path: "apps/web/components/ui/CopyButton.tsx",
			side: "new",
			start: 5,
			end: 6,
			contentHash: "c_0a1b",
		},
		note: "Use the same copy timeout constant here, not a literal.",
		revision: 2,
		status: "current",
		createdAt: T0 - 25 * MIN,
	},
	{
		id: "ann_2",
		author: "agent",
		source: "file",
		anchor: {
			kind: "file",
			path: "apps/design-system/fixtures/chat.ts",
			start: 300,
			end: 306,
			contentHash: "c_77ee",
		},
		note: "Split this fixture module if it passes 500 lines.",
		revision: 1,
		status: "stale",
		createdAt: T0 - 18 * MIN,
	},
	{
		id: "ann_3",
		author: "operator",
		source: "text",
		anchor: { kind: "text", text: "the mixed-anchor group", contentHash: "c_3f02" },
		note: "Clarify which group key this is.",
		revision: 1,
		status: "orphaned",
		createdAt: T0 - 9 * MIN,
	},
	{
		id: "ann_4",
		author: "agent",
		source: "message",
		anchor: {
			kind: "entry",
			anchor: { sessionId: "sess_9d2c", entryId: "e_005", revision: "r_2" },
		},
		note: "This tsc failure is the one to fix first.",
		revision: 1,
		status: "current",
		createdAt: T0 - 4 * MIN,
	},
];

/** TodoBoardDto: plan phases with a blocked task, a dropped task, and a selected task for TodoPanel. */
export const reviewTodoBoard: TodoBoardDto = {
	revision: "r7",
	selected: { phase: 1, task: 0 },
	phases: [
		{
			name: "Scaffold",
			tasks: [
				{ content: "Create fixtures directory", status: "completed" },
				{ content: "Add type-checked module stubs", status: "completed" },
			],
		},
		{
			name: "Implement",
			tasks: [
				{
					content: "Wire the copy button",
					status: "in_progress",
					notes: ["Mounted on the wrapper"],
				},
				{
					content: "Cover the failed state",
					status: "blocked",
					blocker: "Waiting on the clipboard permission mock",
				},
				{
					content: "Port the old markdown fixture",
					status: "abandoned",
					details: "Superseded by chat.ts",
				},
			],
		},
		{
			name: "Verify",
			tasks: [{ content: "Run the check and lint pipeline", status: "pending" }],
		},
	],
};

const DECISION_STATUS: Record<string, PlanReviewDto["status"]> = {
	approve: "approved",
	request_changes: "changes_requested",
	dismiss: "dismissed",
};

const KIND_ON_MOVE: Partial<Record<GitPathEntry["kind"], GitPathEntry["kind"]>> = {
	untracked: "added",
	added: "untracked",
};

type TodoTask = TodoBoardDto["phases"][number]["tasks"][number];

function argsOf(args: unknown[]): Record<string, unknown> {
	const first = args[0];
	return typeof first === "object" && first !== null ? { ...first } : {};
}

function stringList(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

export interface GitCallOptions {
	status?: GitStatusDto;
	statusError?: string;
	pending?: boolean;
}

/** Git methods over a mutable copy of the status: stage and unstage move rows, commit clears the index. */
export function gitCalls(options: GitCallOptions = {}): CallHandlers {
	const status = structuredClone(options.status ?? reviewGitStatus);
	let revision = 0;
	const advance = (): void => {
		revision += 1;
		status.indexFingerprint = `idx_${(0x3a91 + revision).toString(16)}`;
		status.clean = status.staged.length === 0 && status.unstaged.length === 0;
	};
	const checkFingerprint = (sent: unknown): void => {
		if (sent !== status.indexFingerprint)
			throw new Error(
				`stale fingerprint: index is now ${status.indexFingerprint}, refresh and retry`,
			);
	};
	const move = (
		from: GitPathEntry[],
		to: GitPathEntry[],
		pick: (row: GitPathEntry) => boolean,
	): void => {
		for (const row of from.filter(pick)) {
			from.splice(from.indexOf(row), 1);
			to.push({ ...row, kind: KIND_ON_MOVE[row.kind] ?? row.kind });
		}
		advance();
	};
	return {
		gitStatus: () => {
			if (options.pending) return Promise.withResolvers<never>().promise;
			if (options.statusError !== undefined) throw new Error(options.statusError);
			return structuredClone(status);
		},
		gitFileDiff: (args) => {
			const { path } = argsOf(args);
			const diff = [reviewGitDiff, reviewGitDiffBinary].find((item) => item.path === path);
			if (!diff) throw new Error(`no diff fixture for ${String(path)}`);
			return structuredClone(diff);
		},
		gitStage: (args) => {
			const a = argsOf(args);
			checkFingerprint(a.fingerprint);
			const paths = stringList(a.paths);
			move(status.unstaged, status.staged, (row) => a.all === true || paths.includes(row.path));
			return true;
		},
		gitUnstage: (args) => {
			const a = argsOf(args);
			checkFingerprint(a.fingerprint);
			const paths = stringList(a.paths);
			move(status.staged, status.unstaged, (row) => a.all === true || paths.includes(row.path));
			return true;
		},
		gitStageHunks: (args) => {
			checkFingerprint(argsOf(args).fingerprint);
			throw new Error("hunk staging is not simulated by the design fixtures");
		},
		gitCommit: (args) => {
			const a = argsOf(args);
			checkFingerprint(a.fingerprint);
			const sha = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
			status.head = {
				sha,
				shortSha: sha.slice(0, 7),
				subject: String(a.message).split("\n")[0],
				authorName: "Joshua",
				authorEmail: "joshua@example.dev",
				authorDate: "2026-10-09T12:00:00+00:00",
			};
			status.staged = [];
			advance();
			return { sha };
		},
	};
}

export interface PlanCallOptions {
	plan?: PlanReviewDto | null;
	loadError?: string;
	decisionError?: string;
	pending?: boolean;
}

/** Plan methods over a mutable copy of the plan; decisions refuse a stale version, as the session does. */
export function planCalls(options: PlanCallOptions = {}): CallHandlers {
	let plan = structuredClone(options.plan === undefined ? reviewPlan : options.plan);
	const setStatus = (args: unknown[], status: PlanReviewDto["status"]): boolean => {
		if (options.decisionError !== undefined) throw new Error(options.decisionError);
		if (argsOf(args).version !== plan?.version)
			throw new Error("stale plan version: the plan changed, refresh and retry");
		plan = plan && { ...plan, status };
		return true;
	};
	return {
		planGet: () => {
			if (options.pending) return Promise.withResolvers<never>().promise;
			if (options.loadError !== undefined) throw new Error(options.loadError);
			return structuredClone(plan);
		},
		planDecide: (args) => setStatus(args, DECISION_STATUS[String(argsOf(args).decision)]),
		planReopen: (args) => setStatus(args, "waiting"),
	};
}

export interface AnnotationCallOptions {
	rows?: ReviewAnnotationDto[];
	loadError?: string;
	pending?: boolean;
}

/** Annotation methods over a mutable copy of the rows: create, remove and compose as the sidebar uses them. */
export function annotationCalls(options: AnnotationCallOptions = {}): CallHandlers {
	let rows = structuredClone(options.rows ?? reviewAnnotations);
	let nextId = 5;
	return {
		annotationList: () => {
			if (options.pending) return Promise.withResolvers<never>().promise;
			if (options.loadError !== undefined) throw new Error(options.loadError);
			return structuredClone(rows);
		},
		annotationCreate: (args) => {
			const note = String(argsOf(args).note);
			rows = [
				...rows,
				{
					id: `ann_${nextId}`,
					author: "operator",
					source: "text",
					anchor: { kind: "text", text: note, contentHash: "" },
					note,
					revision: 1,
					status: "current",
					createdAt: FIXTURE_NOW,
				},
			];
			nextId += 1;
			return true;
		},
		annotationRemove: (args) => {
			const id = argsOf(args).id;
			rows = rows.filter((row) => row.id !== id);
			return true;
		},
		annotationCompose: (args) => {
			const a = argsOf(args);
			const ids = stringList(a.ids);
			const prompt = rows
				.filter((row) => ids.includes(row.id))
				.map((row) => `- ${row.note}`)
				.join("\n");
			return { intent: String(a.intent), prompt, submitted: false };
		},
	};
}

export interface TodoCallOptions {
	board?: TodoBoardDto;
	conflict?: boolean;
	loadError?: string;
	pending?: boolean;
}

/** Todo methods over a mutable copy of the board; applying ops checks the base revision, as the session does. */
export function todoCalls(options: TodoCallOptions = {}): CallHandlers {
	const board = structuredClone(options.board ?? reviewTodoBoard);
	return {
		todoGet: () => {
			if (options.pending) return Promise.withResolvers<never>().promise;
			if (options.loadError !== undefined) throw new Error(options.loadError);
			return structuredClone(board);
		},
		todoApply: (args) => {
			const a = argsOf(args);
			if (options.conflict || a.baseRevision !== board.revision)
				throw new Error(`stale revision: the board is at ${board.revision}, refresh and retry`);
			const ops = Array.isArray(a.ops) ? (a.ops as TodoReviewOp[]) : [];
			const errors: string[] = [];
			const targets: TodoTask[] = [];
			for (const op of ops) {
				const task =
					op.op === "done" ? board.phases[Number(op.phase)]?.tasks[Number(op.task)] : undefined;
				if (task) targets.push(task);
				else errors.push(`cannot apply ${op.op} at phase ${op.phase}, task ${op.task}`);
			}
			if (errors.length > 0) return { errors };
			for (const task of targets) task.status = "completed";
			board.revision = `r${Number(board.revision.slice(1)) + 1}`;
			return {};
		},
		todoImport: () => {
			throw new Error("markdown import is not simulated by the design fixtures");
		},
		todoExport: () => ({
			markdown: board.phases
				.map((phase) =>
					[
						`## ${phase.name}`,
						...phase.tasks.map(
							(task) => `- [${task.status === "completed" ? "x" : " "}] ${task.content}`,
						),
					].join("\n"),
				)
				.join("\n\n"),
		}),
	};
}
