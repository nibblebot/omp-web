import type { WebSessionState } from "#lib/wire/protocol";

type GoalModeState = WebSessionState["goalModeState"];
type GoalPayload = NonNullable<GoalModeState>["goal"];

/** Goal mirror: the full server goal-mode state (the badge and dialog read `goalModeState.goal`). */
export interface GoalState {
	goalModeState: GoalModeState;
}

export function createGoalState(): GoalState {
	return { goalModeState: undefined };
}

/** The goal_updated frame: the full goal-mode state when the server sends it, plus the bare goal payload. */
export interface GoalUpdatedEvent {
	goal?: GoalPayload | null;
	state?: GoalModeState;
}

/**
 * Pure reduction for goal_updated. The full state wins when present; otherwise
 * a minimal active state is derived from the goal payload.
 */
export function applyGoalUpdated(event: GoalUpdatedEvent): GoalState {
	const goalModeState: GoalModeState =
		event.state ?? (event.goal ? { enabled: true, mode: "active", goal: event.goal } : undefined);
	return { goalModeState };
}
