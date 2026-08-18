import type { Component } from "solid-js";
import { setState, state } from "../../state";
import { InfoIcon, PanelLeftIcon, SettingsIcon } from "../shared/icons";

// ---------------------------------------------------------------------------
// Sidebar footer: global chrome (transcripts browser, debug panel,
// settings). In roster chat these live here instead of the StatusBar
// header — StatusBar hides its debug/settings segments while the sidebar
// is present (`state.sessionMode !== "roster" || state.view !== "chat"`), so
// the two renderings never coexist.
// ---------------------------------------------------------------------------

export const SidebarFooter: Component = () => (
	<div class="sidebar-foot">
		<button
			class="sidebar-icon-btn"
			classList={{ active: state.view === "transcripts" }}
			onClick={() => setState("view", (v) => (v === "transcripts" ? "chat" : "transcripts"))}
			title="Transcripts"
			aria-label="Transcripts"
		>
			<PanelLeftIcon /> tx
		</button>
		<button
			class="sidebar-icon-btn"
			classList={{ active: state.modal === "debug" }}
			onClick={() => setState("modal", state.modal === "debug" ? null : "debug")}
			title="Debug — transport and fleet visibility"
			aria-label="Debug — transport and fleet visibility"
		>
			<InfoIcon />
		</button>
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
