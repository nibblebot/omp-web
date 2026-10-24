import type { Component } from "solid-js";
import { setState } from "../../state";

/** Opens the background jobs sheet; the jobs feature's control in its Settings > Features row. */
export const JobsButton: Component = () => (
	<button
		type="button"
		class="settings-control-btn"
		onClick={() => setState("modal", "jobs")}
		title="Background jobs of this session and its subagents"
	>
		Open Background Jobs
	</button>
);
