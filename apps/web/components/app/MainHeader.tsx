import { createSignal, For, Show, type Component, type JSX } from "solid-js";
import { GoalBadge } from "../chat/status/GoalBadge";
import { LiveShareBadge } from "../chat/status/LiveShareBadge";
import {
	openAppearance,
	setSidebarVisible,
	setState,
	setTxSidebarVisible,
	state,
} from "../../state";
import { openCommandPalette } from "../../store/palette";
import { KebabMenu } from "../ui/KebabMenu";
import { PaletteIcon, PanelLeftIcon, SearchIcon, SettingsIcon } from "../ui/icons";

/** One header action, shown as an icon button on wide screens and a menu row on phones. */
interface HeaderAction {
	label: string;
	title: string;
	icon: Component;
	run: () => void;
}

const HEADER_ACTIONS: readonly HeaderAction[] = [
	{
		label: "Command palette",
		title: "Search commands, sessions and settings (Ctrl+K)",
		icon: SearchIcon,
		run: openCommandPalette,
	},
	{ label: "Appearance", title: "Appearance", icon: PaletteIcon, run: openAppearance },
	{
		label: "Settings",
		title: "Settings",
		icon: SettingsIcon,
		run: () => setState("modal", "settings"),
	},
];

/**
 * Main pane header, shared by Chat (live session and the no-session pane) and
 * Analysis. Left: the sidebar open toggle (only while the current view's
 * sidebar is closed) and the title slot. Right: the goal badge and the Live
 * share badge when `session` is set, then the command palette (search) button, the
 * Appearance button (opens the AppearanceSheet) and the settings gear, always rightmost.
 * Below 768px the goal badge compacts first (shell.css); below 480px the badges wrap onto
 * their own row under the controls and the three action buttons fold into one "More
 * actions" menu so the session title keeps the room. The title shrinks last.
 */
export const MainHeader: Component<{
	title?: JSX.Element;
	/** Show the session goal and Live share badges. */
	session?: boolean;
}> = (props) => {
	const [moreOpen, setMoreOpen] = createSignal(false);
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
				<div class="main-header-actions">
					<For each={HEADER_ACTIONS}>
						{(action) => (
							<button
								type="button"
								class="main-header-btn"
								onClick={() => action.run()}
								title={action.title}
								aria-label={action.label}
							>
								<action.icon />
							</button>
						)}
					</For>
				</div>
				<KebabMenu
					label="More actions"
					class="main-header-more"
					open={moreOpen()}
					onOpenChange={setMoreOpen}
				>
					<For each={HEADER_ACTIONS}>
						{(action) => (
							<button
								type="button"
								role="menuitem"
								class="sidebar-menu-item"
								onClick={() => {
									setMoreOpen(false);
									action.run();
								}}
							>
								<action.icon />
								{action.label}
							</button>
						)}
					</For>
				</KebabMenu>
			</div>
		</header>
	);
};
