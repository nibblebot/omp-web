import {
	createEffect,
	createMemo,
	createSignal,
	For,
	Show,
	type Component,
	type JSX,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import { activityButtons, currentSummaries, pressActivityButton } from "../../activities/bar";
import { compactComposer, openAttachPicker } from "../../prompt/compact-composer";
import { isActivitiesOpen, type ActivitySectionId } from "../../store/activities";
import {
	ACTIVITY_ICON,
	ACTIVITY_POPOVER,
	ACTIVITY_SECTIONS,
} from "../activities/activity-sections";
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
import { PaletteIcon, PanelLeftIcon, PaperclipIcon, SearchIcon, SettingsIcon } from "../ui/icons";

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
 *
 * On a live session in that phone layout the menu also carries what the one-row composer
 * has no room for: Attach files and one item per Activities section that has items
 * (Subagents, Jobs, Daemons, Todo; the ActivityBar shows these on wider layouts), with a
 * dot on the trigger while any of them runs. An activity item opens its section's popover
 * anchored to the trigger (or scrolls the open Activities panel to it).
 */
export const MainHeader: Component<{
	title?: JSX.Element;
	/** Show the session goal and Live share badges. */
	session?: boolean;
}> = (props) => {
	const [moreOpen, setMoreOpen] = createSignal(false);
	let moreTrigger: HTMLButtonElement | undefined;
	const sessionItems = () => props.session === true && compactComposer();
	const buttons = createMemo(() => (sessionItems() ? activityButtons(currentSummaries()) : []));
	const running = () => buttons().some((b) => !b.muted);
	const [popover, setPopover] = createSignal<ActivitySectionId | undefined>();
	// A popover never outlives its section, the phone layout or the panel it points at.
	createEffect(() => {
		const section = popover();
		if (section === undefined) return;
		if (isActivitiesOpen() || !buttons().some((b) => b.section === section)) setPopover(undefined);
	});
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
					label={running() ? "More actions, activity running" : "More actions"}
					class={running() ? "main-header-more main-header-more--running" : "main-header-more"}
					open={moreOpen()}
					onOpenChange={(next) => {
						// The open popover is anchored to the trigger: a press there closes it.
						if (next && popover() !== undefined) setPopover(undefined);
						else setMoreOpen(next);
					}}
					triggerRef={(el) => (moreTrigger = el)}
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
					<Show when={sessionItems()}>
						<div class="sidebar-menu-sep" role="separator" />
						<button
							type="button"
							role="menuitem"
							class="sidebar-menu-item"
							onClick={() => {
								setMoreOpen(false);
								openAttachPicker();
							}}
						>
							<PaperclipIcon />
							Attach files
						</button>
						<For each={ACTIVITY_SECTIONS}>
							{(section) => (
								<Show when={buttons().find((b) => b.section === section)}>
									{(model) => (
										<button
											type="button"
											role="menuitem"
											class="sidebar-menu-item"
											data-muted={model().muted ? "" : undefined}
											aria-label={model().ariaLabel}
											aria-haspopup="dialog"
											onClick={() => {
												setMoreOpen(false);
												if (pressActivityButton(section) === "popover") setPopover(section);
											}}
										>
											<Dynamic component={ACTIVITY_ICON[section]} class="activity-bar-icon" />
											{model().label}
											<Show when={model().badge !== ""}>
												<span class="sidebar-menu-badge">{model().badge}</span>
											</Show>
										</button>
									)}
								</Show>
							)}
						</For>
					</Show>
				</KebabMenu>
				<Show when={popover()} keyed>
					{(section) => (
						<Dynamic
							component={ACTIVITY_POPOVER[section]}
							anchor={moreTrigger!}
							onClose={() => setPopover(undefined)}
						/>
					)}
				</Show>
			</div>
		</header>
	);
};
