import { AnnotationsPanel } from "../components/review/AnnotationsPanel";
import { ReviewPanel } from "../components/review/ReviewPanel";
import { Modal } from "../components/ui/Modal";
import { pushNotice, setState } from "../state";
import { openDock } from "../store/dock";
import type { FeatureCommand, FeatureModule } from "./registry";

/** Bare `/git` opens the git review dock beside the chat; arguments are terminal-only, as for the sheets. */
const git: FeatureCommand = {
	detail: "Git review panel",
	run(args) {
		if (args.trim())
			pushNotice(
				"error",
				"/git arguments are terminal-only; type /git alone to open it in the browser.",
			);
		else openDock("review");
	},
};

/** Bare `/annotations` opens the annotations sheet. Arguments belong to the terminal UI, whose output never reaches the browser. */
const annotations: FeatureCommand = {
	detail: "Annotations panel",
	run(args) {
		if (args.trim())
			pushNotice(
				"error",
				"/annotations arguments are terminal-only; type /annotations alone to open it in the browser.",
			);
		else setState("modal", "annotations");
	},
};

export default {
	id: "git",
	modals: {
		annotations: (props) => (
			<Modal variant="sheet" title="Annotations" class="review-sheet" onClose={props.onClose}>
				<AnnotationsPanel />
			</Modal>
		),
	},
	docks: { review: { title: "Git review", body: ReviewPanel } },
	commands: { git, annotations },
} satisfies FeatureModule;
