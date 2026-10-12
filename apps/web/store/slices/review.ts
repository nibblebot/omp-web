import type {
	GitStatusDto,
	PlanReviewDto,
	ReviewAnnotationDto,
	TodoBoardDto,
} from "#lib/wire/protocol";

export interface GitReviewDiff {
	path: string;
	area: "unstaged" | "staged" | "commit";
	oldText?: string;
	newText?: string;
	binary: boolean;
	tooLarge: boolean;
	fingerprint: string;
	patch?: string;
	truncated?: boolean;
	hunks: { index: number; header: string; text: string }[];
}
export interface TodoReviewOp {
	op: string;
	phase?: string;
	task?: string;
	items?: string[];
	list?: { phase: string; items: string[] }[];
	[key: string]: unknown;
}
export interface ReviewState {
	/** Bumped on every reset; in-flight review RPCs compare it and drop results from before the reset. */
	generation: number;
	gitStatus: GitStatusDto | null;
	gitLoading: boolean;
	gitError: string | null;
	gitSelection: string[];
	selectedHunks: number[];
	fileDiff: GitReviewDiff | null;
	planReview: PlanReviewDto | null;
	planLoading: boolean;
	planError: string | null;
	annotations: ReviewAnnotationDto[];
	annotationsLoading: boolean;
	annotationsError: string | null;
	composerInsert: string | null;
	todoBoard: TodoBoardDto | null;
	todoLoading: boolean;
	todoError: string | null;
	todoConflict: boolean;
	todoDraft: string;
	selectedTodo: { phase: number; task: number } | null;
}
export function createReviewState(): ReviewState {
	return {
		generation: 0,
		gitStatus: null,
		gitLoading: false,
		gitError: null,
		gitSelection: [],
		selectedHunks: [],
		fileDiff: null,
		planReview: null,
		planLoading: false,
		planError: null,
		annotations: [],
		annotationsLoading: false,
		annotationsError: null,
		composerInsert: null,
		todoBoard: null,
		todoLoading: false,
		todoError: null,
		todoConflict: false,
		todoDraft: "",
		selectedTodo: null,
	};
}
/** Fresh review state for a session switch; the bumped generation invalidates in-flight RPCs. */
export function resetReviewState(previous: ReviewState): ReviewState {
	return { ...createReviewState(), generation: previous.generation + 1 };
}
