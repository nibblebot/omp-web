/**
 * Per-workspace dock layout: which dock panel a workspace had open, its agents
 * mode and filter, the accordion's remembered expanded agent, and the agents whose
 * children are collapsed in the dock tree. Keyed by daemon id and persisted in
 * one versioned localStorage record. The dock width stays global (prefs/dock.ts).
 *
 * Storage is read fresh on every call: the record is small, and a second tab
 * or a test reset can never leave a stale in-memory copy behind. Unknown or
 * corrupt shapes degrade to the default layout, never throw.
 */
export type AgentsMode = "single" | "accordion";

/** Which agents the dock lists: every subagent, or only the active ones. */
export type AgentsFilter = "all" | "running";

/** An open dock panel: `kind` picks the panel, `id` an item inside it. */
export interface DockSelection {
	kind: string;
	id?: string;
}

export interface DockLayout {
	/** The open dock panel, or null when closed. */
	dock: DockSelection | null;
	mode: AgentsMode;
	filter: AgentsFilter;
	/** The accordion's remembered expanded agent (survives closing the dock). */
	expanded?: string;
	/** Agent ids whose children are collapsed in the dock tree. */
	treeCollapsed: string[];
}

const STORAGE_KEY = "omp-web:dock-layouts:v1";
const DOCK_KIND = /^[a-z][a-z0-9-]*$/;

export function defaultDockLayout(): DockLayout {
	return { dock: null, mode: "single", filter: "all", treeCollapsed: [] };
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value !== "";
}

function parseDock(value: unknown): DockSelection | null {
	if (typeof value !== "object" || value === null) return null;
	const { kind, id } = value as Record<string, unknown>;
	if (typeof kind !== "string" || !DOCK_KIND.test(kind)) return null;
	if (id === undefined) return { kind };
	return nonEmptyString(id) ? { kind, id } : { kind };
}

function parseLayout(value: unknown): DockLayout {
	const layout = defaultDockLayout();
	if (typeof value !== "object" || value === null) return layout;
	const raw = value as Record<string, unknown>;
	layout.dock = parseDock(raw.dock);
	if (raw.mode === "accordion") layout.mode = "accordion";
	if (raw.filter === "running") layout.filter = "running";
	if (nonEmptyString(raw.expanded)) layout.expanded = raw.expanded;
	if (Array.isArray(raw.treeCollapsed))
		layout.treeCollapsed = [...new Set(raw.treeCollapsed.filter(nonEmptyString))];
	return layout;
}

function readAll(): Record<string, DockLayout> {
	try {
		const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
		if (raw === null || raw === undefined) return {};
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		const out: Record<string, DockLayout> = {};
		for (const [daemonId, value] of Object.entries(parsed)) out[daemonId] = parseLayout(value);
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
export function readDockLayout(daemonId: string): DockLayout {
	return readAll()[daemonId] ?? defaultDockLayout();
}

export function persistDockLayout(daemonId: string, layout: DockLayout): void {
	const all = readAll();
	all[daemonId] = layout;
	writeAll(all);
}

/** Drop the layouts of workspaces that left the roster. */
export function pruneDockLayouts(liveDaemonIds: ReadonlySet<string>): void {
	const all = readAll();
	let changed = false;
	for (const daemonId of Object.keys(all)) {
		if (liveDaemonIds.has(daemonId)) continue;
		delete all[daemonId];
		changed = true;
	}
	if (changed) writeAll(all);
}
