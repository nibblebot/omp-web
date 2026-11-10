/**
 * Per-workspace dock layout: which dock panel a workspace had open and its
 * Activities panel layout (mode, folded sections, expanded item ids, collapsed
 * subagent-tree rows, filters, `lastFocused`). Keyed by workspace id and persisted in
 * one versioned localStorage record. The dock width stays global (prefs/dock.ts).
 *
 * Storage is read fresh on every call: the record is small, and a second tab
 * or a test reset can never leave a stale in-memory copy behind. Unknown or
 * corrupt shapes degrade to the default layout, never throw. The v1 record is
 * deleted on load and never migrated.
 */
import { SUBAGENT_SCOPES } from "../subagents/scope";
import {
	ACTIVITY_SECTIONS,
	type ActivitiesMode,
	type ActivityDetailRef,
	type ActivityFilters,
	type ActivitySectionId,
} from "../store/slices/activities";

/** An open dock panel: `kind` picks the panel; `item` (route only, never persisted) names an item inside it. */
export interface DockSelection {
	kind: string;
	item?: { type: string; id: string };
}

/** The Activities panel's persisted layout; the serializable twin of `ActivitiesSlice` (no detail, no focus request). */
export interface ActivitiesLayout {
	mode: ActivitiesMode;
	collapsedSections: ActivitySectionId[];
	expanded: { subagents: string[]; jobs: string[]; daemons: string[] };
	treeCollapsed: string[];
	filters: ActivityFilters;
	lastFocused?: ActivityDetailRef;
}

export interface DockLayout {
	/** The open dock panel (its kind only), or null when closed. */
	dock: { kind: string } | null;
	activities: ActivitiesLayout;
}

const STORAGE_KEY = "omp-web:dock-layouts:v2";
const LEGACY_STORAGE_KEY = "omp-web:dock-layouts:v1";
const DOCK_KIND = /^[a-z][a-z0-9-]*$/;

export function defaultActivitiesLayout(): ActivitiesLayout {
	return {
		mode: "accordion",
		collapsedSections: [],
		expanded: { subagents: [], jobs: [], daemons: [] },
		treeCollapsed: [],
		filters: { subagents: "all", jobs: "all" },
	};
}

export function defaultDockLayout(): DockLayout {
	return { dock: null, activities: defaultActivitiesLayout() };
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value !== "";
}

function stringSet(value: unknown): string[] {
	return Array.isArray(value) ? [...new Set(value.filter(nonEmptyString))] : [];
}

function parseDock(value: unknown): { kind: string } | null {
	if (typeof value !== "object" || value === null) return null;
	const { kind } = value as Record<string, unknown>;
	return typeof kind === "string" && DOCK_KIND.test(kind) ? { kind } : null;
}

function parseFocus(value: unknown): ActivityDetailRef | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { section, id } = value as Record<string, unknown>;
	if ((section !== "subagents" && section !== "jobs") || !nonEmptyString(id)) return undefined;
	return { section, id };
}

function parseActivities(value: unknown): ActivitiesLayout {
	const layout = defaultActivitiesLayout();
	if (typeof value !== "object" || value === null) return layout;
	const raw = value as Record<string, unknown>;
	if (raw.mode === "detail") layout.mode = "detail";
	layout.collapsedSections = stringSet(raw.collapsedSections).filter((s): s is ActivitySectionId =>
		(ACTIVITY_SECTIONS as readonly string[]).includes(s),
	);
	const expanded = (
		typeof raw.expanded === "object" && raw.expanded !== null ? raw.expanded : {}
	) as Record<string, unknown>;
	layout.expanded = {
		subagents: stringSet(expanded.subagents),
		jobs: stringSet(expanded.jobs),
		daemons: stringSet(expanded.daemons),
	};
	layout.treeCollapsed = stringSet(raw.treeCollapsed);
	const filters = (
		typeof raw.filters === "object" && raw.filters !== null ? raw.filters : {}
	) as Record<string, unknown>;
	const scope = SUBAGENT_SCOPES.find((entry) => entry.id === filters.subagents);
	if (scope !== undefined) layout.filters.subagents = scope.id;
	if (filters.jobs === "running") layout.filters.jobs = "running";
	const lastFocused = parseFocus(raw.lastFocused);
	if (lastFocused !== undefined) layout.lastFocused = lastFocused;
	return layout;
}

function parseLayout(value: unknown): DockLayout {
	if (typeof value !== "object" || value === null) return defaultDockLayout();
	const raw = value as Record<string, unknown>;
	return { dock: parseDock(raw.dock), activities: parseActivities(raw.activities) };
}

function readAll(): Record<string, DockLayout> {
	try {
		// The v1 (agents dock) record is dropped, never migrated.
		globalThis.localStorage?.removeItem(LEGACY_STORAGE_KEY);
		const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
		if (raw === null || raw === undefined) return {};
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		const out: Record<string, DockLayout> = {};
		for (const [workspaceId, value] of Object.entries(parsed))
			out[workspaceId] = parseLayout(value);
		return out;
	} catch {
		return {};
	}
}

function writeAll(layouts: Record<string, DockLayout>): void {
	try {
		if (Object.keys(layouts).length === 0) globalThis.localStorage?.removeItem(STORAGE_KEY);
		else globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(layouts));
	} catch {
		// Storage can be unavailable (private mode); the layout still applies for this page.
	}
}

/** The saved layout of one workspace; the default layout when none was saved or the record is corrupt. */
export function readDockLayout(workspaceId: string): DockLayout {
	return readAll()[workspaceId] ?? defaultDockLayout();
}

export function persistDockLayout(workspaceId: string, layout: DockLayout): void {
	const all = readAll();
	all[workspaceId] = layout;
	writeAll(all);
}

/** Drop the layouts of workspaces that left the roster. */
export function pruneDockLayouts(liveWorkspaceIds: ReadonlySet<string>): void {
	const all = readAll();
	let changed = false;
	for (const workspaceId of Object.keys(all)) {
		if (liveWorkspaceIds.has(workspaceId)) continue;
		delete all[workspaceId];
		changed = true;
	}
	if (changed) writeAll(all);
}
