import { Show, type Component } from "solid-js";
import { setView, state } from "../../state";
import { BarChart3Icon, TerminalIcon } from "../ui/icons";

/** Chat/Analysis segmented pair at the top of each roster sidebar. The Chat
 *  button carries the activity dot (state.chatUnviewed) while a turn ends
 *  unattended in Analysis; both modes persist independently. */
export const ViewSwitch: Component = () => (
	<div class="mode-switch" role="group" aria-label="View mode">
		<button
			type="button"
			class="sidebar-icon-btn"
			classList={{ active: state.view === "chat" }}
			onClick={() => setView("chat")}
			title="Chat"
			aria-label="Chat"
		>
			<TerminalIcon />
			<Show when={state.chatUnviewed}>
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
