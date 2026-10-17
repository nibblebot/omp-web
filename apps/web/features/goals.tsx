import { GoalDialog } from "../components/chat/controls/GoalDialog";
import { GoalBadge } from "../components/chat/status/GoalBadge";
import { goalRouteArgs } from "./goal-dispatch";
import type { FeatureModule } from "./registry";
import "./goals.css";

export default {
	id: "goals",
	modals: { goal: GoalDialog },
	commands: {
		goal: {
			detail: "Goal controls (/goal set|show|pause|resume|drop|budget)",
			run: goalRouteArgs,
		},
	},
	mainHeader: { goalBadge: GoalBadge },
} satisfies FeatureModule;
