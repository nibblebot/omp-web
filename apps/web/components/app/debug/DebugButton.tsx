import type { Component } from "solid-js";
import { setState } from "../../../state";

/** Opens the debug sheet; the debug feature's control in its Settings > Features row. */
export const DebugButton: Component = () => (
	<button
		type="button"
		class="settings-control-btn"
		onClick={() => setState("modal", "debug")}
		title="Debug, transport and fleet visibility"
	>
		Open Debug Sheet
	</button>
);
