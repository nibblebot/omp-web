import type { ModalName } from "../state.ts";

/**
 * Static feature manifest: the only feature metadata the entry chunk carries.
 * Feature code lives behind `import()` in `registry.ts`, so a disabled
 * feature's JS/CSS chunk is never fetched. Everything here must stay
 * import-free of feature modules (type-only imports are fine).
 */
export type FeatureId = "analysis" | "plan" | "git" | "todos" | "jobs" | "plugins" | "debug";

export type FeatureStatus = "stable" | "in-development";

export interface FeatureInfo {
	id: FeatureId;
	/** User-facing name in Settings > Features. */
	label: string;
	description: string;
	/** Badge in Settings > Features. An "in-development" feature is listed but always off and cannot be turned on. */
	status: FeatureStatus;
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
		status: "in-development",
		defaultEnabled: false,
		commands: [],
		modals: [],
		docks: [],
	},
	{
		id: "plan",
		label: "Plan Mode",
		description: "Toggle plan mode (/plan) and review the plan the agent proposes (/plan-review).",
		status: "in-development",
		defaultEnabled: false,
		commands: ["plan", "plan-review"],
		modals: ["plan-review"],
		docks: [],
	},
	{
		id: "git",
		label: "Git Review",
		description:
			"Git review panel beside the chat (/git) and annotations on its diffs (/annotations).",
		status: "in-development",
		defaultEnabled: false,
		commands: ["git", "annotations"],
		modals: ["annotations"],
		docks: ["review"],
	},
	{
		id: "todos",
		label: "Todos",
		description:
			"The agent's todo tool works and its cards show in the transcript. The /todo command, its subcommands, and the editable todo sheet are in development.",
		status: "in-development",
		defaultEnabled: false,
		commands: ["todo"],
		modals: ["todos"],
		docks: [],
	},
	{
		id: "jobs",
		label: "Background Jobs",
		description:
			"The job tree sheet: background jobs nested under the subagent that runs them, busiest branches first, with Cancel on this session's own jobs. /jobs keeps running the agent's own command meanwhile.",
		status: "in-development",
		defaultEnabled: false,
		commands: [],
		modals: ["jobs"],
		docks: [],
	},
	{
		id: "plugins",
		label: "Plugins",
		description:
			"Enable, disable, and configure installed omp plugins (Extensions dialog, Plugins tab). Installing stays in the terminal.",
		status: "stable",
		defaultEnabled: true,
		commands: [],
		modals: [],
		docks: [],
	},
	{
		id: "debug",
		label: "Debug Sheet",
		description: "Build identity, fleet and transport debug log, opened from this row.",
		status: "stable",
		defaultEnabled: true,
		commands: [],
		modals: ["debug"],
		docks: [],
	},
];

export const FEATURE_IDS: readonly FeatureId[] = FEATURES.map((f) => f.id);

/**
 * Ids the app can turn on: every feature whose status is not "in-development".
 * An in-development feature is listed in Settings > Features but never active,
 * so anything that activates features outside the app's own load path (the
 * design system) activates these and no others.
 */
export const ENABLEABLE_FEATURE_IDS: readonly FeatureId[] = FEATURES.filter(
	(f) => f.status !== "in-development",
).map((f) => f.id);

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
