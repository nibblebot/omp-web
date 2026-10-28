/**
 * The right-hand dock (U18): which panel is open and how wide. The panel kinds
 * are registered by components/app/DockHost.tsx; this module is kind-agnostic
 * and only owns the open/close/width/restore state. `state.dock` is mirrored
 * into the URL by store/deep-link.ts. The Activities panel's own actions live
 * in store/activities.ts.
 *
 * The dock layout is per workspace (workspace id): `state.dock` and
 * `state.activities` are the live truth for the attached workspace; every
 * change saves them to that workspace's record (prefs/dock-layout.ts), and
 * `restoreDockLayout` loads a record back when the attached workspace changes.
 * The dock width stays global.
 */
import { batch } from "solid-js";
import { clampDockWidth, persistDockWidth } from "../prefs/dock";
import {
	type ActivitiesLayout,
	type DockLayout,
	type DockSelection,
	persistDockLayout,
	pruneDockLayouts,
	readDockLayout,
} from "../prefs/dock-layout";
import { setState, state } from "../state";
import { closeItemDetail } from "./activities";
import { unwindDockEntries } from "./overlay-history";
import type { DockRoute } from "./route";
import type { ActivitiesSlice } from "./slices/activities";

/** Write `state.dock`. The explicit `item` key matters: the store merges objects, and `undefined` deletes a stale item. */
export function showDock(selection: DockSelection | null): void {
	setState("dock", selection === null ? null : { kind: selection.kind, item: selection.item });
}

function layoutOf(slice: ActivitiesSlice): ActivitiesLayout {
	return {
		mode: slice.mode,
		collapsedSections: [...slice.collapsedSections],
		expanded: {
			subagents: [...slice.expanded.subagents],
			jobs: [...slice.expanded.jobs],
			daemons: [...slice.expanded.daemons],
		},
		treeCollapsed: [...slice.treeCollapsed],
		filters: { ...slice.filters },
		...(slice.lastFocused === undefined ? {} : { lastFocused: { ...slice.lastFocused } }),
	};
}

function sliceOf(layout: ActivitiesLayout): ActivitiesSlice {
	return {
		mode: layout.mode,
		collapsedSections: new Set(layout.collapsedSections),
		expanded: {
			subagents: new Set(layout.expanded.subagents),
			jobs: new Set(layout.expanded.jobs),
			daemons: new Set(layout.expanded.daemons),
		},
		treeCollapsed: new Set(layout.treeCollapsed),
		filters: { ...layout.filters },
		lastFocused: layout.lastFocused,
		detail: undefined,
		focusRequest: undefined,
	};
}

/** Save the live layout into the attached workspace's record; nothing is attached, nothing to save. */
export function persistDockState(): void {
	const workspaceId = state.currentWorkspaceId;
	if (workspaceId === "") return;
	persistDockLayout(workspaceId, {
		dock: state.dock === null ? null : { kind: state.dock.kind },
		activities: layoutOf(state.activities),
	});
}

/** Open a dock panel, or retarget it. A no-op when it is already open on that panel. */
export function openDock(kind: string): void {
	if (state.dock?.kind === kind) return;
	showDock({ kind });
	persistDockState();
}

export function closeDock(): void {
	if (state.dock === null) return;
	setState("dock", null);
	persistDockState();
}

/**
 * The user closes the dock from its UI (close button, Back from the panel).
 * Unlike `closeDock` (programmatic and route-driven closes) this also unwinds
 * the history entries the open dock pushed, so the browser's Back does not
 * reopen it. The unwinding starts before the state change: the route sync then
 * waits for it and finds the URL already dock-less.
 */
export function dismissDock(): void {
	if (state.dock === null) return;
	unwindDockEntries();
	closeDock();
}

/** Back or Esc on the open dock: the Activities detail steps back to its list; anything else closes. */
export function backFromDock(): void {
	if (state.dock?.kind === "activities" && state.activities.detail !== undefined) closeItemDetail();
	else dismissDock();
}

/** Open the generic dock panel the URL names; item routes belong to the panel's own store (store/activities.ts). */
export function applyRouteDock(route: DockRoute): void {
	showDock({ kind: route.kind });
	persistDockState();
}

/**
 * Load a workspace's saved layout into the live state. Called when the
 * attached workspace changes (the `attached` frame, inside the same batch that
 * writes `currentWorkspaceId`), so the route sync never sees the previous
 * workspace's dock under the new id. Never writes the record: it is the source.
 *
 * Where the dock covers the whole viewport (the sidebar-drawer breakpoint) the
 * saved open panel is not reopened, like drawers always start closed: a reload
 * or PWA restore must land on the chat, not on a full-screen Activities list.
 * Its Activities layout (mode, folds, filters) is still restored.
 */
export function restoreDockLayout(workspaceId: string): void {
	const saved: DockLayout = readDockLayout(workspaceId);
	batch(() => {
		showDock(state.drawerViewport ? null : saved.dock);
		setState("activities", sliceOf(saved.activities));
	});
}

/** Forget the saved layouts of workspaces that left the roster; waits for a non-empty roster. */
export function pruneDockLayoutsToRoster(): void {
	if (state.sessionRoster.length === 0) return;
	pruneDockLayouts(new Set(state.sessionRoster.map((d) => d.workspaceId)));
}

/** Set and persist the dock width (clamped to the allowed range and the viewport). */
export function setDockWidth(px: number): void {
	const width = clampDockWidth(px, globalThis.innerWidth);
	setState("dockWidth", width);
	persistDockWidth(width);
}

/** Alt+A opens the Activities panel. Exact "a" key only: Option+A on mac types "å". */
export function isActivitiesShortcut(
	e: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "shiftKey">,
): boolean {
	return e.altKey && !e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "a";
}
