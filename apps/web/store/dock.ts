/**
 * The right-hand dock (U18): which panel is open and how wide, plus the
 * agents-dock layout. The panel kinds are registered by
 * components/app/DockHost.tsx; this module only owns state. `state.dock` is
 * mirrored into the URL by store/deep-link.ts.
 *
 * The dock layout is per workspace (daemon id): `state.dock`, `agentsMode`, `agentsFilter`,
 * `agentsExpanded` and `agentTreeCollapsed` are the live truth for the attached
 * workspace; every change here saves them to that workspace's record
 * (prefs/dock-layout.ts), and `restoreDockLayout` loads a record back when the
 * attached workspace changes. The dock width stays global.
 */
import { batch } from "solid-js";
import { clampDockWidth, persistDockWidth } from "../prefs/dock";
import {
	persistDockLayout,
	pruneDockLayouts,
	readDockLayout,
	type AgentsFilter,
	type AgentsMode,
	type DockSelection,
} from "../prefs/dock-layout";
import { setState, state } from "../state";
import type { DockRoute } from "./route";
import { subagentById } from "./subagents";

export type { AgentsFilter, AgentsMode };

/** Write `state.dock`. The explicit `id` key matters: the store merges objects, and `undefined` deletes a stale id. */
function showDock(selection: DockSelection | null): void {
	setState("dock", selection === null ? null : { kind: selection.kind, id: selection.id });
}

/** Save the live layout into the attached workspace's record; nothing is attached, nothing to save. */
function persistLayout(): void {
	const daemonId = state.currentSessionId;
	if (daemonId === "") return;
	const dock = state.dock;
	persistDockLayout(daemonId, {
		dock:
			dock === null ? null : { kind: dock.kind, ...(dock.id === undefined ? {} : { id: dock.id }) },
		mode: state.agentsMode,
		filter: state.agentsFilter,
		...(state.agentsExpanded === undefined ? {} : { expanded: state.agentsExpanded }),
		treeCollapsed: [...state.agentTreeCollapsed],
	});
}

/** Open a dock panel, or retarget it. A no-op when it is already open on that panel. */
export function openDock(kind: string, id?: string): void {
	const current = state.dock;
	if (current !== null && current.kind === kind && current.id === id) return;
	batch(() => {
		showDock({ kind, id });
		// The accordion remembers its expanded agent beyond closing the dock.
		if (kind === "agents" && id !== undefined) setState("agentsExpanded", id);
	});
	persistLayout();
}

export function closeDock(): void {
	if (state.dock === null) return;
	setState("dock", null);
	persistLayout();
}

/** Back or Esc on the open dock: an agent pane steps back to the agents list; anything else closes. */
export function backFromDock(): void {
	if (state.dock?.kind === "agent") openDock("agents");
	else closeDock();
}

/** The attached workspace's agents mode. */
export function agentsMode(): AgentsMode {
	return state.agentsMode;
}

/** The attached workspace's agents filter. */
export function agentsFilter(): AgentsFilter {
	return state.agentsFilter;
}

/** Show every agent or only the running ones; saved with the workspace's layout. */
export function setAgentsFilter(filter: AgentsFilter): void {
	if (state.agentsFilter === filter) return;
	setState("agentsFilter", filter);
	persistLayout();
}

/** Switch the agents mode, carrying the selection: `agent/X` becomes `agents/X` and back. */
export function setAgentsMode(mode: AgentsMode): void {
	if (state.agentsMode === mode) return;
	const dock = state.dock;
	batch(() => {
		setState("agentsMode", mode);
		if (mode === "accordion" && dock?.kind === "agent" && dock.id !== undefined) {
			showDock({ kind: "agents", id: dock.id });
			setState("agentsExpanded", dock.id);
		} else if (mode === "single") {
			if (dock?.kind === "agents" && dock.id !== undefined)
				showDock({ kind: "agent", id: dock.id });
			// The selection now lives in the dock segment, not in the accordion's memory.
			setState("agentsExpanded", undefined);
		}
	});
	persistLayout();
}

/** Open one agent in the workspace's mode: its own pane (single) or expanded in the list (accordion). */
export function openAgent(id: string): void {
	if (state.agentsMode === "single") openDock("agent", id);
	else openDock("agents", id);
}

/** Open the agents panel: the list (single), or the list with the remembered agent expanded (accordion). */
export function openAgents(): void {
	if (state.agentsMode === "single") openDock("agents");
	else openDock("agents", state.agentsExpanded);
}

/** The agent expanded in the accordion; undefined when all are collapsed or another panel is open. */
export function expandedAgentId(): string | undefined {
	return state.dock?.kind === "agents" ? state.dock.id : undefined;
}

/** Expand an agent in the accordion, or collapse it when it is already the expanded one. */
export function toggleAgentExpanded(id: string): void {
	if (expandedAgentId() !== id) {
		openDock("agents", id);
		return;
	}
	batch(() => {
		showDock({ kind: "agents" });
		setState("agentsExpanded", undefined);
	});
	persistLayout();
}

/** Agents whose children are collapsed in the dock tree (the attached workspace's). */
export function agentTreeCollapsed(): ReadonlySet<string> {
	return state.agentTreeCollapsed;
}

export function toggleAgentTreeCollapsed(id: string): void {
	const next = new Set(state.agentTreeCollapsed);
	if (!next.delete(id)) next.add(id);
	setState("agentTreeCollapsed", next);
	persistLayout();
}

/**
 * Open the dock the URL names. `agent/<id>` is the single mode and
 * `agents/<id>` the accordion, so the segment also sets the workspace's mode;
 * the bare `agents` list leaves it alone.
 */
export function applyRouteDock(route: DockRoute): void {
	batch(() => {
		if (route.id !== undefined && route.kind === "agent") setState("agentsMode", "single");
		else if (route.id !== undefined && route.kind === "agents") setState("agentsMode", "accordion");
		showDock(route);
		if (route.kind === "agents" && route.id !== undefined) setState("agentsExpanded", route.id);
	});
	persistLayout();
}

/**
 * Load a workspace's saved layout into the live state. Called when the
 * attached workspace changes (the `attached` frame, inside the same batch that
 * writes `currentSessionId`), so the route sync never sees the previous
 * workspace's dock under the new id. Never writes the record: it is the source.
 */
export function restoreDockLayout(daemonId: string): void {
	const saved = readDockLayout(daemonId);
	batch(() => {
		showDock(saved.dock);
		setState("agentsMode", saved.mode);
		setState("agentsFilter", saved.filter);
		setState("agentsExpanded", saved.expanded);
		setState("agentTreeCollapsed", new Set(saved.treeCollapsed));
	});
}

/**
 * Drop an agent id that is not in the attached session (after /new or a
 * resume in the same workspace): the single pane and the accordion row both
 * fall back to the plain agents list, and the remembered id is cleared. Judged
 * only once the session's forest is fully loaded, never while an attach is
 * still filling it.
 */
export function reconcileMissingAgent(): void {
	const { mirror, roster } = state.subagentsLoaded;
	if (!mirror || !roster || state.currentSessionId === "") return;
	const dock = state.dock;
	const dockAgent = dock?.kind === "agent" || dock?.kind === "agents" ? dock.id : undefined;
	const missingDock = dockAgent !== undefined && subagentById(dockAgent) === undefined;
	const remembered = state.agentsExpanded;
	const missingRemembered = remembered !== undefined && subagentById(remembered) === undefined;
	if (!missingDock && !missingRemembered) return;
	batch(() => {
		if (missingDock) showDock({ kind: "agents" });
		if (missingRemembered || missingDock) setState("agentsExpanded", undefined);
	});
	persistLayout();
}

/** Forget the saved layouts of workspaces that left the roster; waits for a non-empty roster. */
export function pruneDockLayoutsToRoster(): void {
	if (state.daemonRoster.length === 0) return;
	pruneDockLayouts(new Set(state.daemonRoster.map((d) => d.daemonId)));
}

/** Set and persist the dock width (clamped to the allowed range). */
export function setDockWidth(px: number): void {
	const width = clampDockWidth(px);
	setState("dockWidth", width);
	persistDockWidth(width);
}

/** Alt+A opens the agents dock. Exact "a" key only: Option+A on mac types "å". */
export function isAgentsShortcut(
	e: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "shiftKey">,
): boolean {
	return e.altKey && !e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "a";
}
