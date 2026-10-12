import { BtwSheet } from "../components/requests/BtwSheet";
import { BtwHistorySheet } from "../components/sessions/BtwHistorySheet";
import { pushNotice, setState } from "../state";
import { askBtw, btwDispatch } from "../store/btw";
import type { FeatureCommand, FeatureModule } from "./registry";
import "./btw.css";

/** `/btw <question>` asks a side-channel question in the panel (never the transcript); bare `/btw` opens the panel empty. */
const btw: FeatureCommand = {
	detail: "Side question (/btw [question])",
	run: (args) => {
		const d = btwDispatch(args);
		askBtw(d.kind === "ask" ? d.question : "");
	},
};

/** Bare `/btw-history` opens the saved side-question history. Arguments are terminal-only. */
const btwHistory: FeatureCommand = {
	detail: "Browse BTW side-question history",
	run: (args) => {
		if (args.trim())
			pushNotice(
				"error",
				"/btw-history arguments are terminal-only; type /btw-history alone to open it in the browser.",
			);
		else setState("modal", "btw-history");
	},
};

export default {
	id: "btw",
	overlays: [BtwSheet],
	modals: {
		"btw-history": (props) => <BtwHistorySheet onClose={props.onClose} />,
	},
	commands: { btw, "btw-history": btwHistory },
} satisfies FeatureModule;
