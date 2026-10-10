import { Show, type Component } from "solid-js";
import { daemonsByProject, setSidebarVisible, setState, state } from "../../../state";
import { ViewSwitch } from "../../app/ViewSwitch";
import { PlusIcon, XIcon } from "../../ui/icons";
import { SidebarFooter } from "./SidebarFooter";
import { ProjectGroups } from "./ProjectGroups";
import { SidebarUsage } from "./SidebarUsage";

// ---------------------------------------------------------------------------
// Fleet-edge roster sidebar (Phase 5). Rendered by App.tsx whenever
// `state.view === "chat"` (the fleet is the only web UI runtime). Shell:
// derives the project-first group list (daemonsByProject) and composes the
// group rendering (ProjectGroups) with the global chrome footer (SidebarFooter).
// Registered projects group their daemons as the main-checkout row first, then
// worktrees; each group carries "+ Add worktree" and a remove-project action.
// Entries WITHOUT a projectId (remote/unregistered) fall back to string-grouping
// in one trailing group. The header "+" opens the Add-repo modal (the retired
// SpawnPicker's template/labels fields live in its advanced section). Row
// interactions live in WorkspaceRow/DaemonDetailsDialog; collapse state persists per
// project in localStorage (ProjectGroups). A pinned mode row (ViewSwitch plus
// the sidebar close button) tops the column above the Projects header. On
// narrow viewports the sidebar is a layout drawer, not a ModalHost overlay:
// it owns its .sidebar-scrim (tap outside closes), shown only by CSS.
// ---------------------------------------------------------------------------

export const FleetSidebar: Component = () => {
	/** Project-first grouping: registered projects in registry order (zero-
	 *  daemon projects included) + one trailing fallback group for entries
	 *  without a projectId. */
	const groups = () => daemonsByProject();

	return (
		<>
			<aside class="sidebar" classList={{ open: state.sidebarVisible }}>
				{/* Top chrome: Chat/Analysis mode switch flush left, sidebar close
			    flush right. Pinned above the scrolling roster so both stay
			    reachable; the Projects header below keeps the add action. */}
				<div class="sidebar-mode-row">
					<ViewSwitch />
					<button
						class="sidebar-icon-btn"
						onClick={() => setSidebarVisible(false)}
						title="Close sidebar"
						aria-label="Close sidebar"
					>
						<XIcon />
					</button>
				</div>
				<div class="sidebar-list">
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
				{/* Setting-gated condensed usage panel: docked between the roster
			    list and the footer chrome. */}
				<Show when={state.sidebarUsage}>
					<SidebarUsage />
				</Show>
				{/* Global chrome moved out of the StatusBar: debug panel and
			    settings (the view mode switch lives in the mode row above). */}
				<SidebarFooter />
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
