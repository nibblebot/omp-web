import type { WebSessionState } from "#lib/wire/protocol";

type GoalModeState = WebSessionState["goalModeState"];
type GoalPayload = NonNullable<GoalModeState>["goal"];

/** Goal mirror: the active goal's objective plus the full server goal-mode state. */
export interface GoalState {
	goal: { objective: string } | null;
	goalModeState: GoalModeState;
}

export function createGoalState(): GoalState {
	return { goal: null, goalModeState: undefined };
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
	const goal = event.goal ? { objective: event.goal.objective } : null;
	const goalModeState: GoalModeState =
		event.state ?? (event.goal ? { enabled: true, mode: "active", goal: event.goal } : undefined);
	return { goal, goalModeState };
}
