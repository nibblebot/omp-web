import type {
	GitStatusDto,
	PlanReviewDto,
	ReviewAnchor,
	ReviewAnnotationDto,
	ServerCapabilities,
	TodoBoardDto,
	WebMethodName,
} from "#lib/wire/protocol";
import type { GitReviewDiff, TodoReviewOp } from "./slices/review";
import { state, setState } from "../state";
import { call } from "./transport";

export const reviewCaps = (): ServerCapabilities => state.capabilities ?? {};
export const setReviewCaps = (caps: ServerCapabilities): void => {
	setState("capabilities", caps);
};
export const reviewAvailable = (key: "git" | "planReview" | "review" | "todos"): boolean =>
	reviewCaps()[key]?.available === true;
export const unavailableReason = (key: "git" | "planReview" | "review" | "todos"): string =>
	reviewCaps()[key]?.reason ?? "This server does not advertise this capability.";
export const gitStatus = () => state.review.gitStatus;
export const gitLoading = () => state.review.gitLoading;
export const gitError = () => state.review.gitError;
export const gitSelection = () => state.review.gitSelection;
export const selectedHunks = () => state.review.selectedHunks;
export const fileDiff = () => state.review.fileDiff;
export const planReview = () => state.review.planReview;
export const planLoading = () => state.review.planLoading;
export const planError = () => state.review.planError;
export const annotations = () => state.review.annotations;
export const annotationsLoading = () => state.review.annotationsLoading;
export const annotationsError = () => state.review.annotationsError;
export const composerInsert = () => state.review.composerInsert;
export const clearComposerInsert = (): void => {
	setState("review", "composerInsert", null);
};
export const todoBoard = () => state.review.todoBoard;
export const todoLoading = () => state.review.todoLoading;
export const todoError = () => state.review.todoError;
export const todoConflict = () => state.review.todoConflict;
export const todoDraft = () => state.review.todoDraft;
export const selectedTodo = () => state.review.selectedTodo;
export const setTodoDraft = (text: string): void => {
	setState("review", "todoDraft", text);
};
export const selectTodo = (selection: { phase: number; task: number } | null): void => {
	setState("review", "selectedTodo", selection);
};

// P0 publishes the method vocabulary; capability verdicts, never version checks, authorize calls.
const rpc = <T>(method: string, args: unknown[] | Record<string, unknown> = {}): Promise<T> =>
	call(method as WebMethodName, Array.isArray(args) ? args : [args]) as Promise<T>;
const message = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);
const stale = (error: unknown): boolean =>
	/stale|revision|fingerprint|version|conflict/i.test(message(error));
async function run<T>(
	domain: "git" | "plan" | "annotations" | "todo",
	capability: "git" | "planReview" | "review" | "todos",
	task: () => Promise<T>,
	onStale?: () => Promise<unknown>,
): Promise<T | undefined> {
	if (!reviewAvailable(capability) || state.review[`${domain}Loading`]) return;
	const epoch = state.review.generation;
	setState("review", `${domain}Loading`, true);
	setState("review", `${domain}Error`, null);
	try {
		return await task();
	} catch (error) {
		if (epoch !== state.review.generation) return;
		if (stale(error)) {
			if (domain === "todo") setState("review", "todoConflict", true);
			if (onStale) {
				try {
					await onStale();
				} catch {
					/* Preserve the original refusal. */
				}
			}
		}
		setState("review", `${domain}Error`, message(error));
		return undefined;
	} finally {
		if (epoch === state.review.generation) setState("review", `${domain}Loading`, false);
	}
}
async function getGit(): Promise<void> {
	const epoch = state.review.generation;
	const snapshot = await rpc<GitStatusDto>("gitStatus");
	if (epoch !== state.review.generation) return;
	setState("review", "gitStatus", snapshot);
	const paths = new Set([...snapshot.staged, ...snapshot.unstaged].map((row) => row.path));
	setState("review", "gitSelection", (previous) => previous.filter((path) => paths.has(path)));
	if (fileDiff()?.fingerprint !== snapshot.indexFingerprint) {
		setState("review", "fileDiff", null);
		setState("review", "selectedHunks", []);
	}
}
export const refreshGit = () => run("git", "git", getGit);
export function toggleGitPath(path: string): void {
	setState("review", "gitSelection", (values) =>
		values.includes(path) ? values.filter((value) => value !== path) : [...values, path],
	);
}
export function toggleHunk(index: number): void {
	setState("review", "selectedHunks", (values) =>
		values.includes(index) ? values.filter((value) => value !== index) : [...values, index],
	);
}
async function mutateGit(
	method: string,
	args: Record<string, unknown>,
): Promise<boolean | undefined> {
	const snapshot = gitStatus();
	if (!snapshot) return;
	return run(
		"git",
		"git",
		async () => {
			const epoch = state.review.generation;
			await rpc(method, { fingerprint: snapshot.indexFingerprint, ...args });
			if (epoch !== state.review.generation) return;
			await getGit();
			return true;
		},
		getGit,
	);
}
export const stagePaths = (paths: string[] = gitSelection(), all = false) =>
	paths.length || all ? mutateGit("gitStage", { paths, all }) : Promise.resolve(undefined);
export const unstagePaths = (paths: string[] = gitSelection(), all = false) =>
	paths.length || all ? mutateGit("gitUnstage", { paths, all }) : Promise.resolve(undefined);
export const stageHunks = (path = fileDiff()?.path, hunkIndices = selectedHunks()) =>
	path && hunkIndices.length && fileDiff() && !fileDiff()?.truncated
		? mutateGit("gitStageHunks", { path, hunkIndices, fingerprint: fileDiff()!.fingerprint })
		: Promise.resolve(undefined);
export const commitStaged = (text: string) =>
	text.trim() ? mutateGit("gitCommit", { message: text }) : Promise.resolve(undefined);
export const loadFileDiff = (path: string, area: GitReviewDiff["area"] = "unstaged") =>
	run("git", "git", async () => {
		const epoch = state.review.generation;
		const result = await rpc<Omit<GitReviewDiff, "path" | "area">>("gitFileDiff", { path, area });
		if (epoch !== state.review.generation) return;
		setState("review", "fileDiff", { ...result, path, area });
		setState("review", "selectedHunks", []);
	});
async function getPlan(): Promise<void> {
	const epoch = state.review.generation;
	const value = await rpc<PlanReviewDto | null>("planGet");
	if (epoch === state.review.generation) setState("review", "planReview", value);
}
export const refreshPlan = () => run("plan", "planReview", getPlan);
async function mutatePlan(method: string, extra: Record<string, unknown> = {}) {
	const snapshot = planReview();
	if (!snapshot) return;
	return run(
		"plan",
		"planReview",
		async () => {
			const epoch = state.review.generation;
			await rpc(method, { reviewId: snapshot.reviewId, version: snapshot.version, ...extra });
			if (epoch !== state.review.generation) return;
			await getPlan();
			return true;
		},
		getPlan,
	);
}
export const decidePlan = (
	decision: "approve" | "request_changes" | "dismiss",
	note?: string,
	options: Record<string, unknown> = {},
) => mutatePlan("planDecide", { decision, ...(note ? { note } : {}), ...options });
export const reopenPlan = () => mutatePlan("planReopen");
export const cancelPlan = () => mutatePlan("planCancel");
async function getAnnotations(): Promise<void> {
	const epoch = state.review.generation;
	const value = await rpc<ReviewAnnotationDto[]>("annotationList");
	if (epoch === state.review.generation) setState("review", "annotations", value);
}
export const refreshAnnotations = () => run("annotations", "review", getAnnotations);
async function mutateAnnotation(method: string, args: Record<string, unknown>) {
	return run(
		"annotations",
		"review",
		async () => {
			const epoch = state.review.generation;
			await rpc(method, args);
			if (epoch !== state.review.generation) return;
			await getAnnotations();
			return true;
		},
		getAnnotations,
	);
}
export const createAnnotation = (input: {
	source: ReviewAnnotationDto["source"];
	anchor: ReviewAnchor;
	note: string;
}) => mutateAnnotation("annotationCreate", input);
export function updateAnnotation(
	id: string,
	note: string,
	revision = annotations().find((row) => row.id === id)?.revision,
) {
	return revision === undefined
		? Promise.resolve(undefined)
		: mutateAnnotation("annotationUpdate", { id, note, revision });
}
export function removeAnnotation(id: string) {
	const item = annotations().find((row) => row.id === id);
	return item
		? mutateAnnotation("annotationRemove", { id, revision: item.revision })
		: Promise.resolve(undefined);
}
export function reanchorAnnotation(
	id: string,
	anchor: ReviewAnchor,
	revision = annotations().find((row) => row.id === id)?.revision,
) {
	return revision === undefined
		? Promise.resolve(undefined)
		: mutateAnnotation("annotationReanchor", { id, anchor, revision });
}
export const composeForComposer = (
	intent: "insert" | "submit" | "github" = "insert",
	ids: string[] = annotations().map((row) => row.id),
	supplemental?: string,
) =>
	run("annotations", "review", async () => {
		const epoch = state.review.generation;
		const result = await rpc<{ intent: string; prompt: string; submitted: boolean }>(
			"annotationCompose",
			{ ids, intent, supplemental },
		);
		if (epoch === state.review.generation && intent === "insert")
			setState("review", "composerInsert", result.prompt);
		return result;
	});
async function getTodos(): Promise<void> {
	const epoch = state.review.generation;
	const value = await rpc<TodoBoardDto>("todoGet");
	if (epoch === state.review.generation) setState("review", "todoBoard", value);
}
export const refreshTodos = () => run("todo", "todos", getTodos);
async function mutateTodos(method: string, args: Record<string, unknown>) {
	const snapshot = todoBoard();
	if (!snapshot) return;
	return run(
		"todo",
		"todos",
		async () => {
			const epoch = state.review.generation;
			const result = await rpc<{ errors?: string[] }>(method, {
				...args,
				baseRevision: snapshot.revision,
			});
			if (epoch !== state.review.generation) return;
			if (result.errors?.length) throw new Error(result.errors.join("\n"));
			await getTodos();
			if (epoch === state.review.generation) setState("review", "todoConflict", false);
			return true;
		},
		getTodos,
	);
}
export const applyTodoOps = (ops: TodoReviewOp[]) => mutateTodos("todoApply", { ops });
export const importTodos = (markdown: string, confirmed = false) =>
	confirmed ? mutateTodos("todoImport", { markdown, confirmed }) : Promise.resolve(undefined);
export const exportTodos = () =>
	run("todo", "todos", () => rpc<{ markdown: string }>("todoExport"));
