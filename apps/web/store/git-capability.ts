import { state } from "../state";

/**
 * Whether the attached session process advertises git review. Core reads it
 * (the worktree delete dialog offers a review button), so it lives apart from
 * `review.ts`, whose actions ship only with the review features.
 */
export const gitReviewAvailable = (): boolean => state.capabilities?.git?.available === true;
export const gitReviewUnavailableReason = (): string =>
	state.capabilities?.git?.reason ?? "This server does not advertise git review.";
