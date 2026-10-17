import { Show, type Component } from "solid-js";
import { setView, state } from "../../state";
import { isFeatureEnabled } from "../../features/registry";
import { featurePreferences } from "../../features/preferences";
import { BarChart3Icon, TerminalIcon } from "../ui/icons";

/** Chat/Analysis segmented pair at the top of each roster sidebar. The Chat
 *  button carries the activity dot (state.chatUnviewed) while a turn ends
 *  unattended in Analysis; both modes persist independently. Hidden whenever
 *  Analysis is not loaded or is switched off (before the reload applies it),
 *  since Chat is then the only mode. */
export const ViewSwitch: Component = () => (
	<Show when={isFeatureEnabled("analysis") && featurePreferences().analysis}>
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
				<span class="mode-switch-label">Chat</span>
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
				<span class="mode-switch-label">Analysis</span>
			</button>
		</div>
	</Show>
);
