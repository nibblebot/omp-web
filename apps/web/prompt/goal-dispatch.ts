import { pushNotice, setState } from "../state";
import {
	dropGoal,
	parseGoalBudget,
	pauseGoal,
	resumeGoal,
	setGoalBudget,
	startGoal,
	validateObjective,
} from "../store/goals";

export type GoalDispatch =
	| { kind: "popover" }
	| { kind: "error"; message: string }
	| { kind: "start"; objective: string }
	| { kind: "budget"; tokenBudget: number | undefined }
	| { kind: "pause" }
	| { kind: "resume" }
	| { kind: "drop" };

const BUDGET_USAGE = "usage: /goal budget <tokens|off>";

/**
 * `/goal` subcommand grammar: `set <objective>` starts the goal and its first
 * turn; `show` opens the Goal dialog; `pause`, `resume`, `drop`; `budget
 * <N|off>` sets or clears the token budget. Bare, unknown, or `set` without an
 * objective opens the dialog. Invalid arguments return an error, never a prompt.
 */
export function goalDispatch(args: string): GoalDispatch {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { kind: "popover" };
	const [sub, ...rest] = tokens;
	switch (sub) {
		case "set": {
			if (rest.length === 0) return { kind: "popover" };
			const objective = rest.join(" ");
			const invalid = validateObjective(objective);
			if (invalid) return { kind: "error", message: `Goal ${invalid}` };
			return { kind: "start", objective };
		}
		case "show":
			return { kind: "popover" };
		case "pause":
			return rest.length > 0 ? { kind: "popover" } : { kind: "pause" };
		case "resume":
			return rest.length > 0 ? { kind: "popover" } : { kind: "resume" };
		case "drop":
			return rest.length > 0 ? { kind: "popover" } : { kind: "drop" };
		case "budget": {
			if (rest.length !== 1) return { kind: "error", message: BUDGET_USAGE };
			if (rest[0] === "off") return { kind: "budget", tokenBudget: undefined };
			const parsed = parseGoalBudget(rest[0]);
			if ("error" in parsed) return { kind: "error", message: parsed.error };
			return { kind: "budget", tokenBudget: parsed.tokenBudget };
		}
		default:
			return { kind: "popover" };
	}
}

/** Route a `/goal` invocation to the store, or open the Goal dialog. */
export function goalRouteArgs(args: string): void {
	const d = goalDispatch(args);
	switch (d.kind) {
		case "popover":
			setState("modal", "goal");
			return;
		case "error":
			pushNotice("error", d.message);
			return;
		case "start":
			void startGoal(d.objective);
			return;
		case "budget":
			void setGoalBudget(d.tokenBudget);
			return;
		case "pause":
			void pauseGoal();
			return;
		case "resume":
			void resumeGoal();
			return;
		case "drop":
			void dropGoal();
			return;
	}
}
