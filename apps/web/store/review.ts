import type {
	GitStatusDto,
	PlanReviewDto,
	ReviewAnchor,
	ReviewAnnotationDto,
	TodoBoardDto,
	WebMethodName,
} from "#lib/wire/protocol";
import type { GitReviewDiff, TodoReviewOp } from "./slices/review";
import { setPromptInsert, setState, state } from "../state";
import { requestDangerConfirm } from "../prompt/danger-confirm";
import { call } from "./transport";

export const gitReviewAvailable = (): boolean => state.capabilities?.git?.available === true;
export const gitReviewUnavailableReason = (): string =>
	state.capabilities?.git?.reason ?? "This server does not advertise git review.";
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
/** Put text into the composer as an unsent insert; PromptComposer appends it to the draft. */
export const insertIntoComposer = (text: string): void => {
	setPromptInsert({ text });
};
export const todoBoard = () => state.review.todoBoard;
export const todoLoading = () => state.review.todoLoading;
export const todoError = () => state.review.todoError;
export const todoConflict = () => state.review.todoConflict;
export const todoDraft = () => state.review.todoDraft;
export const setTodoDraft = (text: string): void => {
	setState("review", "todoDraft", text);
};

// Methods dispatch by name; only the git verdict gates calls, never version checks.
const rpc = <T>(method: string, args: unknown[] | Record<string, unknown> = {}): Promise<T> =>
	call(method as WebMethodName, Array.isArray(args) ? args : [args]) as Promise<T>;
const message = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);
export const isStaleError = (error: unknown): boolean =>
	/stale|revision|fingerprint|version|conflict/i.test(message(error));
async function run<T>(
	domain: "git" | "plan" | "annotations" | "todo",
	task: () => Promise<T>,
	onStale?: () => Promise<unknown>,
): Promise<T | undefined> {
	if ((domain === "git" && !gitReviewAvailable()) || state.review[`${domain}Loading`]) return;
	const epoch = state.review.generation;
	setState("review", `${domain}Loading`, true);
	setState("review", `${domain}Error`, null);
	try {
		return await task();
	} catch (error) {
		if (epoch !== state.review.generation) return;
		if (isStaleError(error)) {
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
	const kept = [...state.review.gitSelection].filter((path) => paths.has(path));
	// Replaced only when something was dropped, so a refresh that keeps every selected path wakes no row.
	if (kept.length !== state.review.gitSelection.size)
		setState("review", "gitSelection", new Set(kept));
	if (fileDiff()?.fingerprint !== snapshot.indexFingerprint) {
		setState("review", "fileDiff", null);
		setState("review", "selectedHunks", []);
	}
}
export const refreshGit = () => run("git", getGit);
export function toggleGitPath(path: string): void {
	const next = new Set(state.review.gitSelection);
	if (!next.delete(path)) next.add(path);
	setState("review", "gitSelection", next);
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
		async () => {
			const epoch = state.review.generation;
			await rpc(method, { fingerprint: snapshot.indexFingerprint, ...args });
			if (epoch !== state.review.generation) return;
			// The mutation already landed. A failed status refresh must not read as a
			// refused change (REV-14), so it is reported on its own.
			try {
				await getGit();
			} catch (refreshError) {
				setState(
					"review",
					"gitError",
					`Change applied; status refresh failed: ${message(refreshError)}. Refresh to update.`,
				);
			}
			return true;
		},
		getGit,
	);
}
export const stagePaths = (paths: string[] = [...gitSelection()], all = false) =>
	paths.length || all ? mutateGit("gitStage", { paths, all }) : Promise.resolve(undefined);
export const unstagePaths = (paths: string[] = [...gitSelection()], all = false) =>
	paths.length || all ? mutateGit("gitUnstage", { paths, all }) : Promise.resolve(undefined);
export const stageHunks = (path = fileDiff()?.path, hunkIndices = selectedHunks()) =>
	path && hunkIndices.length && fileDiff() && !fileDiff()?.truncated
		? mutateGit("gitStageHunks", { path, hunkIndices, fingerprint: fileDiff()!.fingerprint })
		: Promise.resolve(undefined);
const commitStaged = (text: string) =>
	text.trim() ? mutateGit("gitCommit", { message: text }) : Promise.resolve(undefined);
const filesLabel = (count: number): string => `${count} file${count === 1 ? "" : "s"}`;
/** Ask before staging every worktree change; the stage runs only on confirm. */
export function requestStageAll(): void {
	const count = gitStatus()?.unstaged.length ?? 0;
	requestDangerConfirm({
		title: "Stage all changes?",
		body: `${filesLabel(count)} in the worktree will be staged. This does not commit them.`,
		confirmLabel: `Stage ${filesLabel(count)}`,
		onConfirm: () => void stagePaths([], true),
	});
}
/** Ask before committing the staged changes; `onCommitted` runs only after a landed commit. */
export function requestCommit(text: string, onCommitted: () => void): void {
	const count = gitStatus()?.staged.length ?? 0;
	const subject = text.trim().split("\n", 1)[0];
	requestDangerConfirm({
		title: "Commit staged changes?",
		body: `${filesLabel(count)} staged will be committed with the message: ${subject}`,
		confirmLabel: "Commit",
		onConfirm: () =>
			void commitStaged(text).then((landed) => {
				if (landed !== undefined) onCommitted();
			}),
	});
}
/**
 * Esc in a review text field that holds an unsaved draft: claim the key so the
 * dock (which closes on an unclaimed Esc and discards the panel's local drafts)
 * stays open. An empty field lets Esc close the dock as usual.
 */
export function guardDraftEscape(event: KeyboardEvent, draft: string): void {
	if (event.key === "Escape" && draft.trim() !== "") event.preventDefault();
}
export const loadFileDiff = (path: string, area: GitReviewDiff["area"] = "unstaged") =>
	run("git", async () => {
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
export const refreshPlan = () => run("plan", getPlan);
async function mutatePlan(method: string, extra: Record<string, unknown> = {}) {
	const snapshot = planReview();
	if (!snapshot) return;
	return run(
		"plan",
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
async function getAnnotations(): Promise<void> {
	const epoch = state.review.generation;
	const value = await rpc<ReviewAnnotationDto[]>("annotationList");
	if (epoch === state.review.generation) setState("review", "annotations", value);
}
export const refreshAnnotations = () => run("annotations", getAnnotations);
async function mutateAnnotation(method: string, args: Record<string, unknown>) {
	return run(
		"annotations",
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
export function removeAnnotation(id: string) {
	const item = annotations().find((row) => row.id === id);
	return item
		? mutateAnnotation("annotationRemove", { id, revision: item.revision })
		: Promise.resolve(undefined);
}
export const composeForComposer = (
	intent: "insert" | "submit" | "github" = "insert",
	ids: string[] = annotations().map((row) => row.id),
	supplemental?: string,
) =>
	run("annotations", async () => {
		const epoch = state.review.generation;
		const result = await rpc<{ intent: string; prompt: string; submitted: boolean }>(
			"annotationCompose",
			{ ids, intent, supplemental },
		);
		if (epoch === state.review.generation && intent === "insert") insertIntoComposer(result.prompt);
		return result;
	});

/** Annotations queued to ride along with the next prompt; the annotations panel toggles them. */
export const queuedAnnotationIds = (): string[] => state.review.queuedAnnotationIds;
export const toggleQueuedAnnotation = (id: string): void => {
	const queued = state.review.queuedAnnotationIds;
	setState(
		"review",
		"queuedAnnotationIds",
		queued.includes(id) ? queued.filter((queuedId) => queuedId !== id) : [...queued, id],
	);
};

/**
 * Compose the queued annotations ahead of the typed text. The queue is cleared only after the
 * server accepts the composition, so a failed send keeps the queue for a retry or cancel.
 */
export const withQueuedAnnotations = async (text: string): Promise<string> => {
	const ids = [...state.review.queuedAnnotationIds];
	const result = await rpc<{ prompt: string }>("annotationCompose", { ids, intent: "insert" });
	setState(
		"review",
		"queuedAnnotationIds",
		state.review.queuedAnnotationIds.filter((id) => !ids.includes(id)),
	);
	return [result.prompt, text].filter(Boolean).join("\n\n");
};

async function getTodos(): Promise<void> {
	const epoch = state.review.generation;
	const value = await rpc<TodoBoardDto>("todoGet");
	if (epoch === state.review.generation) setState("review", "todoBoard", value);
}
export const refreshTodos = () => run("todo", getTodos);
async function mutateTodos(method: string, args: Record<string, unknown>) {
	const snapshot = todoBoard();
	if (!snapshot) return;
	return run(
		"todo",
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
export const exportTodos = () => run("todo", () => rpc<{ markdown: string }>("todoExport"));
