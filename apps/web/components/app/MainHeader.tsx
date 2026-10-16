import { For, Show, type Component, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import { featureMainHeader } from "../../features/registry";
import { setSidebarVisible, setState, setTxSidebarVisible, state } from "../../state";
import { LayersIcon, PanelLeftIcon, SettingsIcon, WarningIcon } from "../ui/icons";

/**
 * Main pane header, shared by Chat (live session and the no-session pane) and
 * Analysis. Left: the sidebar open toggle (only while the current view's
 * sidebar is closed) and the title slot. Right: the actions slot, the
 * session badges (goal, subagents) when `session` is set, the disconnected
 * pill, and the settings gear, always rightmost. Below 768px the badges
 * compact to icons first (shell.css); the title shrinks last.
 */
export const MainHeader: Component<{
	title?: JSX.Element;
	actions?: JSX.Element;
	/** Show session-scoped badges (goal, subagents). */
	session?: boolean;
}> = (props) => (
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
			{props.actions}
			<Show when={props.session}>
				<For each={featureMainHeader()}>
					{(slot) => (slot.goalBadge ? <Dynamic component={slot.goalBadge} /> : null)}
				</For>
				<Show when={state.subagents.size > 0}>
					<button
						type="button"
						class="segment segment-button main-header-subagents"
						onClick={() => setState("modal", "subagents")}
						title={`${state.subagents.size} subagents`}
						aria-label={`${state.subagents.size} subagents`}
					>
						<LayersIcon />
						<span class="main-header-label">subagents</span>
						<span>{state.subagents.size}</span>
					</button>
				</Show>
			</Show>
			<Show when={!state.connected}>
				<span class="disconnected-pill" role="status" aria-label="disconnected">
					<WarningIcon />
					<span class="main-header-label">disconnected</span>
				</span>
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
