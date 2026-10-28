import { Show, type Component, type JSX } from "solid-js";
import { GoalBadge } from "../chat/status/GoalBadge";
import { LiveShareBadge } from "../chat/status/LiveShareBadge";
import {
	openAppearance,
	setSidebarVisible,
	setState,
	setTxSidebarVisible,
	state,
} from "../../state";
import { PaletteIcon, PanelLeftIcon, SettingsIcon } from "../ui/icons";

/**
 * Main pane header, shared by Chat (live session and the no-session pane) and
 * Analysis. Left: the sidebar open toggle (only while the current view's
 * sidebar is closed) and the title slot. Right: the goal badge and the Live
 * share badge when `session` is set, the Appearance button (opens the
 * AppearanceSheet), and the settings gear, always rightmost. Below 768px the
 * goal badge compacts first (shell.css); the title shrinks last.
 */
export const MainHeader: Component<{
	title?: JSX.Element;
	/** Show the session goal and Live share badges. */
	session?: boolean;
}> = (props) => {
	return (
		<header class="main-header">
			<Show when={!(state.view === "chat" ? state.sidebarVisible : state.txSidebarVisible)}>
				<button
					type="button"
					class="main-header-btn"
					onClick={() =>
						state.view === "chat" ? setSidebarVisible(true) : setTxSidebarVisible(true)
					}
					title={state.view === "chat" ? "Open roster sidebar" : "Open transcripts sidebar"}
					aria-label={state.view === "chat" ? "Open roster sidebar" : "Open transcripts sidebar"}
					aria-expanded={false}
				>
					<PanelLeftIcon />
				</button>
			</Show>
			<div class="main-header-title">{props.title}</div>
			<div class="main-header-end">
				<Show when={props.session}>
					<GoalBadge />
					<LiveShareBadge />
				</Show>
				<button
					type="button"
					class="main-header-btn"
					onClick={openAppearance}
					title="Appearance"
					aria-label="Appearance"
				>
					<PaletteIcon />
				</button>
				<button
					type="button"
					class="main-header-btn"
					onClick={() => setState("modal", "settings")}
					title="Settings"
					aria-label="Settings"
				>
					<SettingsIcon />
				</button>
			</div>
		</header>
	);
};
