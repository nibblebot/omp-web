import type { Component } from "solid-js";
import { For } from "solid-js";
import { Dynamic } from "solid-js/web";
import { featureSidebarFooter } from "../../../features/registry";
import { setState } from "../../../state";
import { SettingsIcon } from "../../ui/icons";

// ---------------------------------------------------------------------------
// Sidebar footer: global chrome (debug panel, settings). In the Chat view
// these live here instead of the StatusBar header. StatusBar hides its
// debug/settings segments while the sidebar is present
// (`state.view !== "chat"`), so the two renderings never coexist. View mode
// switching (Chat/Analysis) moved out of this footer onto the ViewSwitch row
// atop the sidebar.
// ---------------------------------------------------------------------------

export const SidebarFooter: Component = () => (
	<div class="sidebar-foot">
		<For each={featureSidebarFooter()}>
			{(slot) => (slot.debugButton ? <Dynamic component={slot.debugButton} /> : null)}
		</For>
		<button
			class="sidebar-icon-btn"
			onClick={() => setState("modal", "settings")}
			title="Settings"
			aria-label="Settings"
		>
			<SettingsIcon />
		</button>
	</div>
);
