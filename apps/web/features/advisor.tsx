import "./advisor.css";
import { AdvisorCard } from "../components/chat/transcript/cards/AdvisorCard";
import { AdvisorPanel } from "../components/subagents/AdvisorPanel";
import type { FeatureModule } from "./registry";

export default {
	id: "advisor",
	subagentTabs: [{ id: "advisor", label: "Advisor", rank: 1, panel: AdvisorPanel }],
	transcriptCards: { advisor: AdvisorCard },
} satisfies FeatureModule;
