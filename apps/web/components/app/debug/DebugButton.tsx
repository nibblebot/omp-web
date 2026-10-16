import type { Component } from "solid-js";
import { setState, state } from "../../../state";
import { InfoIcon } from "../../ui/icons";

/** Debug tool button in the sidebar header (both Chat and Analysis). */
export const DebugButton: Component = () => (
	<button
		type="button"
		class="sidebar-icon-btn"
		classList={{ active: state.modal === "debug" }}
		onClick={() => setState("modal", state.modal === "debug" ? null : "debug")}
		title="Debug, transport and fleet visibility"
		aria-label="Debug, transport and fleet visibility"
	>
		<InfoIcon />
	</button>
);
