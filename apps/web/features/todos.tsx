import { TodoPanel } from "../components/review/TodoPanel";
import { Modal } from "../components/ui/Modal";
import { call, setState } from "../state";
import type { FeatureCommand, FeatureModule } from "./registry";

/** Bare `/todo` opens the todos sheet; with arguments it forwards `/todo <args>` to the agent, like the SDK grammar. */
const todo: FeatureCommand = {
	detail: "Todo panel (/todo [subcommand])",
	run(args) {
		const text = args.trim();
		if (text)
			void call("prompt", [`/todo ${text}`]).catch((err) => {
				// The SDK's error class name is noise in a toast (CMD-08).
				setState("error", String(err).replace(/^\w+Error: /, ""));
			});
		else setState("modal", "todos");
	},
};

export default {
	id: "todos",
	modals: {
		todos: (props) => (
			<Modal variant="sheet" title="Todos" class="review-sheet" onClose={props.onClose}>
				<TodoPanel />
			</Modal>
		),
	},
	commands: { todo },
} satisfies FeatureModule;
