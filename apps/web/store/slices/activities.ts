/**
 * Shape and defaults of the Activities dock panel's live state (`state.activities`).
 * Pure: the actions that write it live in store/activities.ts, the per-workspace
 * persistence in prefs/dock-layout.ts.
 */

/** The panel's sections, in their fixed on-screen order. */
export const ACTIVITY_SECTIONS = ["subagents", "jobs", "daemons", "todos"] as const;
export type ActivitySectionId = (typeof ACTIVITY_SECTIONS)[number];

/** `accordion` expands items inline; `detail` fills the panel body with one item. */
export type ActivitiesMode = "accordion" | "detail";

/** Which Subagents / Jobs rows a section lists: all of them or only the active ones. */
export type ActivityFilter = "all" | "running";

/** Sections whose rows expand into a body. */
export type ActivityItemSection = "subagents" | "jobs" | "daemons";

export interface ActivityItemRef {
	section: ActivityItemSection;
	id: string;
}

/** An item that can fill the panel in detail mode (daemons only expand). */
export interface ActivityDetailRef {
	section: "subagents" | "jobs";
	id: string;
}

export interface ActivitiesSlice {
	mode: ActivitiesMode;
	/** Sections the user folded; every section starts expanded. */
	collapsedSections: ReadonlySet<ActivitySectionId>;
	expanded: {
		subagents: ReadonlySet<string>;
		jobs: ReadonlySet<string>;
		daemons: ReadonlySet<string>;
	};
	/** Subagent-tree rows whose children are collapsed. */
	treeCollapsed: ReadonlySet<string>;
	filters: { subagents: ActivityFilter; jobs: ActivityFilter };
	/** The subagent/job last expanded or opened in detail; cleared when it collapses. */
	lastFocused?: ActivityDetailRef;
	/** The item filling the body in detail mode. Not persisted; the URL carries it. */
	detail?: ActivityDetailRef;
	/** One-shot scroll/expand request the panel consumes (`consumeFocusRequest`). */
	focusRequest?: { target: ActivitySectionId | ActivityItemRef; seq: number };
}

/** The slice of a fresh workspace: accordion, every section open, nothing expanded. */
export function createActivitiesState(): ActivitiesSlice {
	return {
		mode: "accordion",
		collapsedSections: new Set(),
		expanded: { subagents: new Set(), jobs: new Set(), daemons: new Set() },
		treeCollapsed: new Set(),
		filters: { subagents: "all", jobs: "all" },
	};
}
