import { createEffect, onCleanup, Show, type Component } from "solid-js";
import { sessionsByProject, setSidebarRunningOnly, setSidebarVisible, state } from "../../../state";
import { openOverlayLayer } from "../../../store/overlay-history";
import { syncProjects } from "../../../store/projects";
import { onForeground } from "../../../store/lifecycle";
import { SidebarHeader } from "../../app/SidebarHeader";
import { ListFilterIcon } from "../../ui/icons";
import { moveRovingFocus, setRovingTabStop } from "../../ui/roving";
import { ProjectGroups } from "./ProjectGroups";
import { SidebarUsage } from "./SidebarUsage";

// ---------------------------------------------------------------------------
// Fleet-edge roster sidebar (Phase 5). Rendered by App.tsx whenever
// `state.view === "chat"` (the fleet is the only web UI runtime). Shell:
// derives the project-first group list (sessionsByProject) and composes the
// group rendering (ProjectGroups) under the shared SidebarHeader (wordmark,
// the running-only filter toggle that hides asleep rows and projects with no
// running row, collapse toggle).
// Each registered project is one group: its rows are the checkouts (main checkout,
// worktrees, clones). The group header carries a "+" (New workspace popover) and a
// remove-project action, both shown on header hover. Rows without a registered
// projectId are not shown. The list ends with an "Add project" row (opens the Add
// project dialog). Row interactions live in
// WorkspaceRow/SessionDetailsDialog; collapse state persists per project in
// localStorage (ProjectGroups). The registry re-syncs on window focus (throttled).
// Below 1024px the sidebar is a
// layout drawer, not a ModalHost overlay: it owns its .sidebar-scrim (tap
// outside closes), shown only by CSS.
// ---------------------------------------------------------------------------

export const FleetSidebar: Component = () => {
	/** One group per registered project, in registry order (zero-session projects included). */
	const groups = () => sessionsByProject();
	// Roster rows (`data-roster-item`: project toggles and workspace rows) share
	// one tab stop; arrows, Home and End move between them (listbox-style).
	let roster!: HTMLDivElement;
	let rosterActive = 0;
	const rosterItems = () => Array.from(roster.querySelectorAll<HTMLElement>("[data-roster-item]"));
	const syncRosterStop = () => {
		const items = rosterItems();
		rosterActive = Math.min(rosterActive, Math.max(items.length - 1, 0));
		setRovingTabStop(items, rosterActive);
	};
	createEffect(() => {
		groups();
		void state.sidebarRunningOnly;
		queueMicrotask(syncRosterStop);
	});
	const onRosterFocusIn = (e: FocusEvent) => {
		const items = rosterItems();
		const index = items.indexOf(e.target as HTMLElement);
		if (index < 0) return;
		rosterActive = index;
		setRovingTabStop(items, index);
	};
	const onRosterKeyDown = (e: KeyboardEvent) => {
		if (!(e.target instanceof HTMLElement) || !e.target.hasAttribute("data-roster-item")) return;
		const items = rosterItems();
		const target = moveRovingFocus(e, items, items.indexOf(e.target), "vertical");
		if (target !== null) rosterActive = target;
	};

	// An open drawer (below 1024px) is a Back-gesture layer: Back closes it.
	createEffect(() => {
		if (!state.drawerViewport || !state.sidebarVisible) return;
		onCleanup(openOverlayLayer(() => setSidebarVisible(false)));
	});

	// Re-sync the project registry when the page returns to the foreground (the store throttles).
	onCleanup(onForeground(syncProjects));

	return (
		<>
			{/* Closed = inert: the clipped/hidden sidebar leaves tab order and the a11y tree. */}
			<aside
				class="sidebar"
				classList={{ open: state.sidebarVisible }}
				inert={!state.sidebarVisible}
			>
				{/* Fixed-width panel: the docked sidebar's width animates, the content inside does not reflow. */}
				<div class="sidebar-panel">
					<SidebarHeader
						onCollapse={() => setSidebarVisible(false)}
						actions={
							<button
								type="button"
								class="sidebar-icon-btn"
								classList={{ active: state.sidebarRunningOnly }}
								onClick={() => setSidebarRunningOnly(!state.sidebarRunningOnly)}
								title={
									state.sidebarRunningOnly ? "Show all sessions" : "Show only running sessions"
								}
								aria-label={
									state.sidebarRunningOnly ? "Show all sessions" : "Show only running sessions"
								}
								aria-pressed={state.sidebarRunningOnly}
							>
								<ListFilterIcon />
							</button>
						}
					/>
					<div
						class="sidebar-list"
						ref={roster}
						onKeyDown={onRosterKeyDown}
						onFocusIn={onRosterFocusIn}
					>
						<ProjectGroups groups={groups()} />
					</div>
					{/* Setting-gated condensed usage panel docked under the roster list. */}
					<Show when={state.sidebarUsage}>
						<SidebarUsage />
					</Show>
				</div>
			</aside>
			<Show when={state.sidebarVisible}>
				<button
					type="button"
					class="sidebar-scrim"
					tabindex={-1}
					onClick={() => setSidebarVisible(false)}
					aria-label="Close sidebar"
				/>
			</Show>
		</>
	);
};
