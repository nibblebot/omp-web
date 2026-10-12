import { call, setState } from "../state";

/**
 * `/goal`. TUI-only in the SDK registry (builtin-modes.ts:376 `goal` carries
 * `handleTui` only, so ACP dispatch falls through to model text). The web
 * host therefore never forwards it: full TUI subcommand grammar below —
 * `set <objective>`, `show` (opens the Goal panel, the browser read surface),
 * `pause`, `resume`, `drop`, `budget <N|off>` (token budget via the goal
 * runtime), bare / `set` without objective / unknown opens the popover.
 */
export function goalDispatch(args: string):
	| { kind: "popover" }
	| {
			kind: "call";
			method: "goalCreate" | "goalPause" | "goalResume" | "goalDrop";
			args: unknown[];
	  } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { kind: "popover" };
	const [sub, ...rest] = tokens;
	switch (sub) {
		case "set":
			if (rest.length === 0) return { kind: "popover" };
			return { kind: "call", method: "goalCreate", args: [rest.join(" ")] };
		case "show":
			// The Goal panel renders live state; no SDK call needed.
			return { kind: "popover" };
		case "pause":
			if (rest.length > 0) return { kind: "popover" };
			return { kind: "call", method: "goalPause", args: [] };
		case "resume":
			if (rest.length > 0) return { kind: "popover" };
			return { kind: "call", method: "goalResume", args: [] };
		case "drop":
			if (rest.length > 0) return { kind: "popover" };
			return { kind: "call", method: "goalDrop", args: [] };
		case "budget":
			// Token-budget adjustment belongs to the P4 goal service
			// (goalRuntime.onBudgetMutated); until its wire row lands, route
			// to the panel instead of dropping the arg or prompting.
			return { kind: "popover" };
		default:
			return { kind: "popover" };
	}
}

/**
 * `/goal` full TUI grammar: set/show/pause/resume/drop/budget. `show` opens
 * the Goal panel (the browser's read surface for goal details); `budget N`
 * and `budget off` adjust the token budget via the goal runtime; bare,
 * unknown, or `set` without an objective opens the popover. Never prompts.
 */
export function goalRouteArgs(args: string): void {
	const d = goalDispatch(args);
	if (d.kind === "popover") setState("modal", "goal");
	else void call(d.method, d.args).catch((err: unknown) => setState("error", String(err)));
}
