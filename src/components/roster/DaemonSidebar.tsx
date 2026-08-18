import type { Component } from "solid-js";
import { daemonsByProject, setSidebarVisible, setState, state } from "../../state";
import { PlusIcon, XIcon } from "../shared/icons";
import { SidebarFooter } from "./SidebarFooter";
import { SidebarGroups } from "./SidebarGroups";

// ---------------------------------------------------------------------------
// Fleet-edge roster sidebar (Phase 5). Rendered by App.tsx only in
// roster mode. Shell: derives the project-first group list (daemonsByProject)
// and composes the group rendering (SidebarGroups) with the global chrome
// footer (SidebarFooter). Registered projects group their daemons — main-
// checkout row first, then worktrees — each group carrying "+ Add worktree"
// and a remove-project action. Entries WITHOUT a projectId (remote/
// unregistered) fall back to string-grouping in one trailing group. The
// header "+" opens the Add-repo modal (the retired SpawnPicker's template/
// labels fields live in its advanced section). Row interactions live in
// DaemonRow/DaemonDetailView; collapse state persists per project in
// localStorage (SidebarGroups).
// ---------------------------------------------------------------------------

export const DaemonSidebar: Component = () => {
	/** Project-first grouping: registered projects in registry order (zero-
	 *  daemon projects included) + one trailing fallback group for entries
	 *  without a projectId. */
	const groups = () => daemonsByProject();

	return (
		<aside class="sidebar" classList={{ open: state.sidebarVisible }}>
			<div class="sidebar-list">
				{/* Static top-level header: single grouping for the whole roster,
				    no caret (not collapsible), no indent; carries the add-project
				    action and the sidebar close button (top-right). Always rendered
				    so the empty-state hint has a referent. */}
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
						<button
							class="sidebar-icon-btn"
							onClick={() => setSidebarVisible(false)}
							title="Close sidebar"
							aria-label="Close sidebar"
						>
							<XIcon />
						</button>
					</span>
				</div>
				<SidebarGroups groups={groups()} />
			</div>
			{/* Global chrome moved out of the StatusBar: transcripts browser,
			    debug panel, settings. */}
			<SidebarFooter />
		</aside>
	);
};
