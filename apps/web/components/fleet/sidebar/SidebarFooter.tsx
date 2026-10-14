import type { Component } from "solid-js";
import { For } from "solid-js";
import { Dynamic } from "solid-js/web";
import { buildInfo } from "../../../build-info";
import { featureSidebarFooter } from "../../../features/registry";
import { setState } from "../../../state";
import { OmpLogoIcon, SettingsIcon } from "../../ui/icons";

// ---------------------------------------------------------------------------
// Sidebar footer: global chrome (debug panel, settings). In the Chat view
// these live here instead of the StatusBar header. StatusBar hides its
// debug/settings segments while the sidebar is present
// (`state.view !== "chat"`), so the two renderings never coexist. View mode
// switching (Chat/Analysis) moved out of this footer onto the ViewSwitch row
// atop the sidebar. Below the buttons sit the build identity lines: omp-web
// version and git hash, then the upstream omp version at the very bottom
// (build-info.ts; a field missing from the build stamp is omitted).
// ---------------------------------------------------------------------------

export const SidebarFooter: Component = () => (
	<div class="sidebar-foot">
		<div class="sidebar-foot-actions">
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
		{(buildInfo.version || buildInfo.gitHash) && (
			<div class="sidebar-build-line" title="omp-web version and commit">
				<span class="sidebar-build-name">omp-web</span>
				{buildInfo.version && <span>v{buildInfo.version}</span>}
				{buildInfo.gitHash && <span>{buildInfo.gitHash}</span>}
			</div>
		)}
		{buildInfo.ompVersion && (
			<div class="sidebar-build-line" title="Upstream omp version">
				<OmpLogoIcon class="sidebar-build-logo" />
				<span class="sidebar-build-name">omp</span>
				<span>v{buildInfo.ompVersion}</span>
			</div>
		)}
	</div>
);
