import { createEffect, onCleanup, Show, type Component } from "solid-js";
import { daemonsByProject, setSidebarVisible, setState, state } from "../../../state";
import { syncProjects } from "../../../store/projects";
import { SidebarHeader } from "../../app/SidebarHeader";
import { PlusIcon } from "../../ui/icons";
import { moveRovingFocus, setRovingTabStop } from "../../ui/roving";
import { ProjectGroups } from "./ProjectGroups";
import { SidebarUsage } from "./SidebarUsage";

// ---------------------------------------------------------------------------
// Fleet-edge roster sidebar (Phase 5). Rendered by App.tsx whenever
// `state.view === "chat"` (the fleet is the only web UI runtime). Shell:
// derives the project-first group list (daemonsByProject) and composes the
// group rendering (ProjectGroups) under the shared SidebarHeader (wordmark,
// view switch, debug, collapse toggle).
// Each registered project is one group: its rows are the checkouts (main checkout,
// worktrees, clones). The group header carries a "+" (New workspace popover) and a
// remove-project action. Rows without a registered projectId are not shown. The
// roster's header "+" opens the Add project dialog. Row interactions live in
// WorkspaceRow/DaemonDetailsDialog; collapse state persists per project in
// localStorage (ProjectGroups). The registry re-syncs on window focus (throttled).
// Below 1024px the sidebar is a
// layout drawer, not a ModalHost overlay: it owns its .sidebar-scrim (tap
// outside closes), shown only by CSS.
// ---------------------------------------------------------------------------

export const FleetSidebar: Component = () => {
	/** One group per registered project, in registry order (zero-daemon projects included). */
	const groups = () => daemonsByProject();
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

	// Re-sync the project registry when the window regains focus (the store throttles).
	window.addEventListener("focus", syncProjects);
	onCleanup(() => window.removeEventListener("focus", syncProjects));

	return (
		<>
			<aside class="sidebar" classList={{ open: state.sidebarVisible }}>
				<SidebarHeader onCollapse={() => setSidebarVisible(false)} />
				<div
					class="sidebar-list"
					ref={roster}
					onKeyDown={onRosterKeyDown}
					onFocusIn={onRosterFocusIn}
				>
					{/* Static top-level header: single grouping for the whole roster,
				    no caret (not collapsible), no indent; carries the add-project
				    action (top-right). Always rendered so the empty-state hint
				    has a referent. */}
					<div class="picker-group-name sidebar-subgroup sidebar-projects-head">
						Projects
						<span class="sidebar-projects-actions">
							<button
								class="sidebar-icon-btn"
								onClick={() => setState("modal", "add-project")}
								title="Add a project"
								aria-label="Add a project"
							>
								<PlusIcon />
							</button>
						</span>
					</div>
					<ProjectGroups groups={groups()} />
				</div>
				{/* Setting-gated condensed usage panel docked under the roster list. */}
				<Show when={state.sidebarUsage}>
					<SidebarUsage />
				</Show>
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
