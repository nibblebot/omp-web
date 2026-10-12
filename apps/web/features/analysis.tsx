import "../tx/tx.css";
import { TranscriptBrowser } from "../tx/TranscriptBrowser";
import type { FeatureModule } from "./registry";

export default {
	id: "analysis",
	view: TranscriptBrowser,
} satisfies FeatureModule;
