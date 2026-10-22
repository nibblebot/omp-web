import { Show, type Component } from "solid-js";
import { connectionState, state, type ConnectionState } from "../../state";
import { WarningIcon } from "../ui/icons";

/** Strip copy while the transport is not connected. */
const STRIP_COPY: Record<Exclude<ConnectionState, "connected">, string> = {
	reconnecting: "Reconnecting...",
	offline: "Offline, actions paused",
};

/** Tooltip on session-bound actions that are paused by the current state.
 *  Empty while connected (the action is live, no tooltip). */
export const PAUSED_TOOLTIP: Record<ConnectionState, string> = {
	connected: "",
	reconnecting: "Reconnecting, this action resumes when the connection is back",
	offline: "Session offline, restart it to resume",
};

/**
 * Thin strip under the main header, rendered only while the transport is not
 * connected. Replaces the header disconnected pill and collapses crash and
 * transport toasts into one calm status line. Hidden while the page's first
 * stream is still opening: nothing has dropped yet, so there is nothing to
 * reconnect (connect() ends that window after a grace if the fleet never answers).
 */
export const ConnectionBar: Component = () => (
	<Show when={connectionState() !== "connected" && !(state.transportStartup && !state.connected)}>
		<div class="connection-bar" role="status" data-state={connectionState()}>
			<WarningIcon />
			<span>{connectionState() === "offline" ? STRIP_COPY.offline : STRIP_COPY.reconnecting}</span>
		</div>
	</Show>
);
