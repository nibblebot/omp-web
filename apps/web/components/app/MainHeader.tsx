import { createSignal, Show, type Component, type JSX } from "solid-js";
import { GoalBadge } from "../chat/status/GoalBadge";
import { LiveShareBadge } from "../chat/status/LiveShareBadge";
import {
	closeAppearance,
	openAppearance,
	setSidebarVisible,
	setState,
	setTxSidebarVisible,
	state,
} from "../../state";
import { PaletteIcon, PanelLeftIcon, SettingsIcon } from "../ui/icons";
import { AppearancePopover } from "./AppearancePopover";

/**
 * Main pane header, shared by Chat (live session and the no-session pane) and
 * Analysis. Left: the sidebar open toggle (only while the current view's
 * sidebar is closed) and the title slot. Right: the goal badge and the Live
 * share badge when `session` is set, the Appearance button, and the settings
 * gear, always rightmost. The Appearance button owns the AppearancePopover
 * (`state.appearanceOpen`, so the palette and settings search can open it
 * too). Analysis stays mounted while Chat shows, so its header mounts the
 * popover only while Analysis is the current view (`analysis`). Below 768px
 * the goal badge compacts first (shell.css); the title shrinks last.
 */
export const MainHeader: Component<{
	title?: JSX.Element;
	/** Show the session goal and Live share badges. */
	session?: boolean;
	/** This header belongs to Analysis (kept mounted, hidden, while Chat shows). */
	analysis?: boolean;
}> = (props) => {
	const [appearanceButton, setAppearanceButton] = createSignal<HTMLButtonElement>();
	const popoverAnchor = () =>
		state.appearanceOpen && (state.view === "analysis") === (props.analysis === true)
			? appearanceButton()
			: undefined;
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
					ref={setAppearanceButton}
					onClick={() => (state.appearanceOpen ? closeAppearance() : openAppearance())}
					title="Appearance"
					aria-label="Appearance"
					aria-haspopup="dialog"
					aria-expanded={popoverAnchor() !== undefined}
				>
					<PaletteIcon />
				</button>
				<Show when={popoverAnchor()}>
					{(anchor) => <AppearancePopover anchor={anchor()} onClose={closeAppearance} />}
				</Show>
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
