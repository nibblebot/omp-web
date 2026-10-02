import { Show, type Component } from "solid-js";
import { setView, state } from "../../state";
import { BarChart3Icon, TerminalIcon } from "./icons";

/** Work/Analysis segmented pair at the top of each roster sidebar. The Work
 *  button carries the activity dot (state.workUnviewed) while a turn ends
 *  unattended in Analysis; both modes persist independently. */
export const ModeSwitch: Component = () => (
	<div class="mode-switch" role="group" aria-label="View mode">
		<button
			type="button"
			class="sidebar-icon-btn"
			classList={{ active: state.view === "work" }}
			onClick={() => setView("work")}
			title="Work"
			aria-label="Work"
		>
			<TerminalIcon />
			<Show when={state.workUnviewed}>
				<span class="mode-switch-dot" />
			</Show>
		</button>
		<button
			type="button"
			class="sidebar-icon-btn"
			classList={{ active: state.view === "analysis" }}
			onClick={() => setView("analysis")}
			title="Analysis"
			aria-label="Analysis"
		>
			<BarChart3Icon />
		</button>
	</div>
);
