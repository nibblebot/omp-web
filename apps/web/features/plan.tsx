import { PlanReviewPanel } from "../components/review/PlanReviewPanel";
import { Modal } from "../components/ui/Modal";
import { call, pushNotice, setState, state } from "../state";
import type { FeatureCommand, FeatureModule } from "./registry";

/**
 * `/plan [prompt]`: TUI-only in the SDK registry (builtin-modes.ts:326 `plan`
 * carries `handleTui` only). Bare toggles plan mode; a prompt arg enters plan
 * mode with that prompt as the first plan turn (handlePlanModeCommand
 * semantics). Args are never dropped and never sent as ordinary agent text.
 */
export function planDispatch(args = ""): {
	method: "setPlanModeState";
	args: [{ enabled: boolean }];
} {
	return {
		method: "setPlanModeState",
		args: [{ enabled: args.trim() ? true : !state.planModeEnabled }],
	};
}

/** The `/plan` handler; the session config bar's plan badge runs it too, through `featureCommand("plan")`. */
export function planToggle(args: string): void {
	const d = planDispatch(args);
	if (args.trim() && !state.planModeEnabled) {
		pushNotice("info", "Plan mode on. The prompt was entered as the first plan turn.");
	}
	void call(d.method, d.args)
		.then(() => (args.trim() ? call("prompt", [args.trim()]) : undefined))
		.catch((err) => {
			// The SDK's error class name is noise in a toast (CMD-08).
			setState("error", String(err).replace(/^\w+Error: /, ""));
		});
}

const plan: FeatureCommand = {
	detail: "Toggle plan mode (/plan [prompt])",
	run: planToggle,
};

/** Bare `/plan-review` opens the plan review sheet. Arguments belong to the terminal UI, whose output never reaches the browser. */
const planReview: FeatureCommand = {
	detail: "Plan review panel",
	run(args) {
		if (args.trim())
			pushNotice(
				"error",
				"/plan-review arguments are terminal-only; type /plan-review alone to open it in the browser.",
			);
		else setState("modal", "plan-review");
	},
};

export default {
	id: "plan",
	modals: {
		"plan-review": (props) => (
			<Modal variant="sheet" title="Plan review" class="review-sheet" onClose={props.onClose}>
				<PlanReviewPanel />
			</Modal>
		),
	},
	commands: { plan, "plan-review": planReview },
} satisfies FeatureModule;
