import "./advisor.css";
import { AdvisorCard } from "../components/chat/transcript/cards/AdvisorCard";
import { AdvisorSheet } from "../components/subagents/AdvisorSheet";
import type { FeatureModule } from "./registry";

export default {
	id: "advisor",
	modals: { advisor: AdvisorSheet },
	transcriptCards: { advisor: AdvisorCard },
} satisfies FeatureModule;
