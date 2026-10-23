import type { ModalName } from "../state.ts";

/**
 * Static feature manifest: the only feature metadata the entry chunk carries.
 * Feature code lives behind `import()` in `registry.ts`, so a disabled
 * feature's JS/CSS chunk is never fetched. Everything here must stay
 * import-free of feature modules (type-only imports are fine).
 */
export type FeatureId =
	| "analysis"
	| "review"
	| "integrations"
	| "plugins"
	| "btw"
	| "goals"
	| "advisor"
	| "debug";

export interface FeatureInfo {
	id: FeatureId;
	/** User-facing name in Settings > Features. */
	label: string;
	description: string;
	/** Marked "Experimental" in Settings > Features. */
	experimental: boolean;
	/** Used when the browser has no stored preference for this feature. */
	defaultEnabled: boolean;
	/** Slash names (no leading `/`) owned by this feature; disabled → local notice, never forwarded. */
	commands: readonly string[];
	/**
	 * Modals owned by this feature; with every owner disabled, ModalHost renders nothing.
	 * A modal may be listed by several features: it renders while any of them is active.
	 */
	modals: readonly ModalName[];
	/** Dock panel kinds owned by this feature; turning it off closes them. */
	docks: readonly string[];
}

export const FEATURES: readonly FeatureInfo[] = [
	{
		id: "analysis",
		label: "Analysis Mode",
		description: "Transcript browser and session statistics view next to Chat.",
		experimental: false,
		defaultEnabled: false,
		commands: [],
		modals: [],
		docks: [],
	},
	{
		id: "review",
		label: "Review",
		description: "Git review, plan review, annotations, and todo panels.",
		experimental: true,
		defaultEnabled: true,
		commands: ["git", "plan-review", "annotations", "todo"],
		modals: ["plan-review", "annotations", "todos"],
		docks: ["review"],
	},
	{
		id: "integrations",
		label: "MCP & Skills",
		description: "MCP server and skill management dialogs (/mcp, /skills).",
		experimental: true,
		defaultEnabled: true,
		commands: ["mcp", "skills"],
		modals: ["integrations"],
		docks: [],
	},
	{
		id: "plugins",
		label: "Plugins",
		description:
			"Enable, disable, and configure installed omp plugins (Extensions dialog, Plugins tab). Installing stays in the terminal.",
		experimental: true,
		defaultEnabled: true,
		commands: [],
		modals: ["integrations"],
		docks: [],
	},
	{
		id: "btw",
		label: "BTW Side Questions",
		description:
			"Ask side questions outside the transcript (/btw) and review, follow up, or promote them.",
		experimental: true,
		defaultEnabled: true,
		commands: ["btw"],
		modals: ["btw"],
		docks: [],
	},
	{
		id: "goals",
		label: "Goals, Loops & Vibe",
		description: "Goal tracking, bounded loops, and vibe mode (/goal).",
		experimental: true,
		defaultEnabled: true,
		commands: ["goal"],
		modals: ["goal"],
		docks: [],
	},
	{
		id: "advisor",
		label: "Advisor in the Browser",
		description:
			"Shows advisor notes and the advisor sheet in this browser. The advisor itself is turned on in Settings > Model > Advisor.",
		experimental: true,
		defaultEnabled: true,
		commands: [],
		modals: ["advisor"],
		docks: [],
	},
	{
		id: "debug",
		label: "Debug Sheet",
		description: "Build identity, fleet and transport debug log, opened from this row.",
		experimental: false,
		defaultEnabled: true,
		commands: [],
		modals: ["debug"],
		docks: [],
	},
];

export const FEATURE_IDS: readonly FeatureId[] = FEATURES.map((f) => f.id);

export const FEATURE_BY_ID = Object.fromEntries(FEATURES.map((f) => [f.id, f])) as Record<
	FeatureId,
	FeatureInfo
>;

export function isFeatureId(value: string): value is FeatureId {
	return Object.hasOwn(FEATURE_BY_ID, value);
}

/** The feature owning a slash name, if any. */
export function featureForCommand(name: string): FeatureInfo | undefined {
	return FEATURES.find((f) => f.commands.includes(name));
}

/**
 * Every feature that lists a modal, in manifest order; core modals return an
 * empty list. A modal may be listed by several features and renders while any
 * of them is active.
 */
export function featuresForModal(name: ModalName): FeatureInfo[] {
	return FEATURES.filter((f) => f.modals.includes(name));
}
