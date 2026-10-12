import { AnnotationsPanel } from "../components/review/AnnotationsPanel";
import { GitPanel } from "../components/review/GitPanel";
import { PlanReviewPanel } from "../components/review/PlanReviewPanel";
import { TodoPanel } from "../components/review/TodoPanel";
import { Modal } from "../components/ui/Modal";
import { call, pushNotice, setState } from "../state";
import type { FeatureCommand, FeatureModule } from "./registry";
import "./review.css";

/** Bare `/name` opens its review sheet. Arguments belong to the terminal UI, whose output never reaches the browser. */
function openSheet(name: "git" | "plan-review" | "annotations", detail: string): FeatureCommand {
	return {
		detail,
		run(args) {
			if (args.trim())
				pushNotice(
					"error",
					`/${name} arguments are terminal-only; type /${name} alone to open it in the browser.`,
				);
			else setState("modal", name);
		},
	};
}

/** Bare `/todo` opens the todos sheet; with arguments it forwards `/todo <args>` to the agent, like the SDK grammar. */
const todo: FeatureCommand = {
	detail: "Todo panel (/todo [subcommand])",
	run(args) {
		const text = args.trim();
		if (text) void call("prompt", [`/todo ${text}`]).catch((err) => setState("error", String(err)));
		else setState("modal", "todos");
	},
};

export default {
	id: "review",
	modals: {
		git: (props) => (
			<Modal variant="sheet" title="Git review" class="review-sheet" onClose={props.onClose}>
				<GitPanel />
			</Modal>
		),
		"plan-review": (props) => (
			<Modal variant="sheet" title="Plan review" class="review-sheet" onClose={props.onClose}>
				<PlanReviewPanel />
			</Modal>
		),
		annotations: (props) => (
			<Modal variant="sheet" title="Annotations" class="review-sheet" onClose={props.onClose}>
				<AnnotationsPanel />
			</Modal>
		),
		todos: (props) => (
			<Modal variant="sheet" title="Todos" class="review-sheet" onClose={props.onClose}>
				<TodoPanel />
			</Modal>
		),
	},
	commands: {
		git: openSheet("git", "Git review panel"),
		"plan-review": openSheet("plan-review", "Plan review panel"),
		annotations: openSheet("annotations", "Annotations panel"),
		todo,
	},
} satisfies FeatureModule;
