/**
 * The Activities dock panel's actions (`state.activities`, shape in
 * store/slices/activities.ts). The panel is the one `activities` dock kind;
 * its layout is saved per workspace with the dock (store/dock.ts persistDockState).
 *
 * View rules (spec 961q): the panel-wide mode is `accordion` (items expand
 * inline, any number across sections) or `detail` (one subagent/job fills the
 * body). `lastFocused` is the subagent/job last expanded or opened in detail,
 * cleared when it collapses; a mode switch carries it: accordion -> detail
 * opens it (else the list), detail -> accordion expands it and asks the panel
 * to scroll to it. Scroll/expand requests are one-shot `focusRequest`s the
 * panel consumes with `consumeFocusRequest`.
 *
 * The detail item is mirrored into `state.dock.item` so the URL
 * (`#/w/<w>/s/<s>/activities/<subagent|job>/<id>`) follows it; the mode is
 * never in the URL.
 */
import { batch } from "solid-js";
import { activityJobRows } from "../activities/summary";
import { setState, state } from "../state";
import { flattenSubagentTree } from "../subagents/tree";
import { closeDock, persistDockState, showDock } from "./dock";
import { jobPollView } from "./job-poll";
import type { DockRoute } from "./route";
import {
	type ActivityDetailRef,
	type ActivityFilter,
	type ActivityItemRef,
	type ActivitySectionId,
	type ActivitiesMode,
} from "./slices/activities";
import { type SubagentNode, subagentForest } from "./subagents";

export type {
	ActivitiesMode,
	ActivitiesSlice,
	ActivityFilter,
	ActivityItemRef,
	ActivityItemSection,
	ActivitySectionId,
} from "./slices/activities";

/** URL item types <-> detail sections. */
const ROUTE_TYPE = { subagents: "subagent", jobs: "job" } as const;

function dockItemOf(
	detail: ActivityDetailRef | undefined,
): { type: string; id: string } | undefined {
	return detail === undefined ? undefined : { type: ROUTE_TYPE[detail.section], id: detail.id };
}

/** The item as a detail target; daemons only expand, so they have none. */
function detailRefOf(ref: ActivityItemRef): ActivityDetailRef | undefined {
	return ref.section === "daemons" ? undefined : { section: ref.section, id: ref.id };
}

function copyRef<T extends { section: string; id: string }>(ref: T): T {
	return { ...ref };
}

/** Apply a mutation, re-mirror the detail item into the dock, and save the workspace layout. */
function commit(mutate: () => void): void {
	batch(() => {
		mutate();
		if (state.dock?.kind === "activities")
			setState("dock", "item", dockItemOf(state.activities.detail));
	});
	persistDockState();
}

function isFocused(ref: ActivityItemRef): boolean {
	const focused = state.activities.lastFocused;
	return focused !== undefined && focused.section === ref.section && focused.id === ref.id;
}

function toggled<T>(set: ReadonlySet<T>, value: T, on: boolean): ReadonlySet<T> {
	const next = new Set(set);
	if (on) next.add(value);
	else next.delete(value);
	return next;
}

function setExpanded(ref: ActivityItemRef, on: boolean): void {
	setState(
		"activities",
		"expanded",
		ref.section,
		toggled(state.activities.expanded[ref.section], ref.id, on),
	);
}

function unfold(section: ActivitySectionId): void {
	if (state.activities.collapsedSections.has(section))
		setState(
			"activities",
			"collapsedSections",
			toggled(state.activities.collapsedSections, section, false),
		);
}

function requestFocus(target: ActivitySectionId | ActivityItemRef): void {
	const seq = (state.activities.focusRequest?.seq ?? 0) + 1;
	setState("activities", "focusRequest", {
		target: typeof target === "string" ? target : copyRef(target),
		seq,
	});
}

/** The panel finished handling a focus request; only the request it handled is cleared. Not persisted. */
export function consumeFocusRequest(seq: number): void {
	if (state.activities.focusRequest?.seq === seq) setState("activities", "focusRequest", undefined);
}

export function isActivitiesOpen(): boolean {
	return state.dock?.kind === "activities";
}

function revealSection(section: ActivitySectionId): void {
	unfold(section);
	// A section is only on screen in the list.
	setState("activities", "detail", undefined);
	requestFocus(section);
}

/** The ids above `id` in the subagent forest (root first); empty for a root or an unknown id. */
function subagentAncestors(id: string): string[] {
	const walk = (nodes: readonly SubagentNode[], path: string[]): string[] | undefined => {
		for (const node of nodes) {
			if (node.id === id) return path;
			const found = walk(node.children, [...path, node.id]);
			if (found !== undefined) return found;
		}
		return undefined;
	};
	return walk(subagentForest(), []) ?? [];
}

/** Open the tree rows above a subagent so its row is drawn (SubagentTree hides the children of collapsed rows). */
function revealSubagentRow(id: string): void {
	const hidden = subagentAncestors(id).filter((ancestor) =>
		state.activities.treeCollapsed.has(ancestor),
	);
	if (hidden.length === 0) return;
	const next = new Set(state.activities.treeCollapsed);
	for (const ancestor of hidden) next.delete(ancestor);
	setState("activities", "treeCollapsed", next);
}

function revealItem(item: ActivityItemRef): void {
	unfold(item.section);
	if (item.section === "subagents") revealSubagentRow(item.id);
	const focus = detailRefOf(item);
	if (focus !== undefined) setState("activities", "lastFocused", focus);
	if (state.activities.mode === "detail" && focus !== undefined) {
		setState("activities", "detail", { ...focus });
		return;
	}
	setState("activities", "detail", undefined);
	setExpanded(item, true);
	requestFocus(item);
}

/**
 * Open the Activities panel. `section` un-collapses that section and scrolls it
 * into view; `item` shows it per the saved mode (accordion: expanded and
 * scrolled to; detail: filling the body; a daemon always expands).
 */
export function openActivities(
	opts: { section?: ActivitySectionId; item?: ActivityItemRef } = {},
): void {
	commit(() => {
		if (opts.item !== undefined) revealItem(opts.item);
		else if (opts.section !== undefined) revealSection(opts.section);
		showDock({ kind: "activities", item: dockItemOf(state.activities.detail) });
	});
}

/** Un-collapse a section and scroll it into view (opens the panel when it is closed). */
export function focusSection(section: ActivitySectionId): void {
	openActivities({ section });
}

export function closeActivities(): void {
	if (isActivitiesOpen()) closeDock();
}

/** Switch the panel-wide mode, carrying `lastFocused` (see the module comment). */
export function setActivitiesMode(mode: ActivitiesMode): void {
	if (state.activities.mode === mode) return;
	const focused =
		state.activities.lastFocused === undefined ? undefined : copyRef(state.activities.lastFocused);
	commit(() => {
		setState("activities", "mode", mode);
		if (mode === "detail") {
			setState("activities", "detail", focused);
			return;
		}
		setState("activities", "detail", undefined);
		if (focused === undefined) return;
		unfold(focused.section);
		setExpanded(focused, true);
		requestFocus(focused);
	});
}

export function toggleSectionCollapsed(section: ActivitySectionId): void {
	commit(() => {
		setState(
			"activities",
			"collapsedSections",
			toggled(
				state.activities.collapsedSections,
				section,
				!state.activities.collapsedSections.has(section),
			),
		);
	});
}

/** Expand or collapse one row. Expanding a subagent/job makes it `lastFocused`; collapsing it clears that. */
export function toggleItemExpanded(ref: ActivityItemRef): void {
	const on = !state.activities.expanded[ref.section].has(ref.id);
	commit(() => {
		setExpanded(ref, on);
		const focus = detailRefOf(ref);
		if (focus === undefined) return;
		if (on) setState("activities", "lastFocused", focus);
		else if (isFocused(ref)) setState("activities", "lastFocused", undefined);
	});
}

/** Fill the panel body with one subagent/job (detail mode). */
export function openItemDetail(ref: ActivityDetailRef): void {
	commit(() => {
		setState("activities", "detail", copyRef(ref));
		setState("activities", "lastFocused", copyRef(ref));
	});
}

/** Back from the detail to the list. `lastFocused` stays; the panel restores the list's scroll position. */
export function closeItemDetail(): void {
	if (state.activities.detail === undefined) return;
	commit(() => setState("activities", "detail", undefined));
}

export function setActivityFilter(section: "subagents" | "jobs", filter: ActivityFilter): void {
	if (state.activities.filters[section] === filter) return;
	commit(() => setState("activities", "filters", section, filter));
}

export function toggleSubagentTreeRow(id: string): void {
	commit(() =>
		setState(
			"activities",
			"treeCollapsed",
			toggled(state.activities.treeCollapsed, id, !state.activities.treeCollapsed.has(id)),
		),
	);
}

/**
 * Open the Activities dock the URL names. An item route shows that item in the
 * saved mode; a bare `activities` route returns the panel to its list, so Back
 * from a detail URL leaves the detail.
 */
export function applyActivitiesRoute(route: DockRoute): void {
	const type = route.item?.type;
	const section = type === "subagent" ? "subagents" : type === "job" ? "jobs" : undefined;
	if (route.item !== undefined && section !== undefined) {
		openActivities({ item: { section, id: route.item.id } });
		return;
	}
	commit(() => {
		setState("activities", "detail", undefined);
		showDock({ kind: "activities" });
	});
}

/**
 * Drop ids the attached session or fleet no longer has (after /new, a resume, a job leaving the poll, a
 * daemon leaving the roster): expanded rows, `lastFocused`, and the open detail (which falls back to the
 * list). Subagents are judged only once the forest is fully loaded, jobs only once the shared poll has
 * answered, daemons only once a `daemons` frame has been applied, never while an attach is still filling
 * them.
 */
export function reconcileMissingActivities(): void {
	if (state.currentWorkspaceId === "") return;
	const { mirror, roster } = state.subagentsLoaded;
	const known: { subagents?: Set<string>; jobs?: Set<string> } = {};
	if (mirror && roster)
		known.subagents = new Set(flattenSubagentTree(subagentForest()).map((n) => n.id));
	if (jobPollView().phase === "ready")
		known.jobs = new Set(activityJobRows().map((row) => row.job.id));
	const daemonKeys = state.daemonsLoaded ? new Set(state.daemons.keys()) : undefined;
	const gone = (section: "subagents" | "jobs" | "daemons", id: string): boolean => {
		const ids = section === "daemons" ? daemonKeys : known[section];
		return ids !== undefined && !ids.has(id);
	};
	const a = state.activities;
	const missingExpanded = (["subagents", "jobs", "daemons"] as const).flatMap((section) =>
		[...a.expanded[section]].filter((id) => gone(section, id)).map((id) => ({ section, id })),
	);
	const lastGone = a.lastFocused !== undefined && gone(a.lastFocused.section, a.lastFocused.id);
	const detailGone = a.detail !== undefined && gone(a.detail.section, a.detail.id);
	if (missingExpanded.length === 0 && !lastGone && !detailGone) return;
	commit(() => {
		for (const ref of missingExpanded) setExpanded(ref, false);
		if (lastGone) setState("activities", "lastFocused", undefined);
		if (detailGone) setState("activities", "detail", undefined);
	});
}
