import { GoalDialog } from "../components/chat/controls/GoalDialog";
import { GoalBadge } from "../components/chat/status/GoalBadge";
import { GoalsAndLoopsTab, VibeTab } from "../components/subagents/GoalLoopPanel";
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
	subagentTabs: [
		{ id: "goals", label: "Goals & Loops", rank: 2, panel: GoalsAndLoopsTab },
		{ id: "vibe", label: "Vibe", rank: 3, panel: VibeTab },
	],
} satisfies FeatureModule;
