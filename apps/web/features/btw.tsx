import { BtwSheet } from "../components/requests/BtwSheet";
import { setState } from "../state";
import { askBtw, btwDispatch } from "../store/btw";
import type { FeatureCommand, FeatureModule } from "./registry";
import "./btw.css";

/** `/btw [question]`: a question starts a saved side turn and opens the sheet to show it; bare `/btw` opens the sheet on its history. Arguments are never sent to the transcript. */
const btw: FeatureCommand = {
	detail: "Side question (/btw [question])",
	run: (args) => {
		const d = btwDispatch(args);
		if (d.kind === "ask") askBtw(d.question);
		setState("modal", "btw");
	},
};

export default {
	id: "btw",
	modals: {
		btw: (props) => <BtwSheet onClose={props.onClose} />,
	},
	commands: { btw },
} satisfies FeatureModule;
