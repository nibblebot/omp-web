import { Show } from "solid-js";
import { state } from "../../../state";
import { openShareSheet } from "../../../store/collab";
import { collabLive } from "../../../store/slices/collab";
import { StatusSegment } from "./StatusSegment";

/** Guests in the live room (the host is not counted). */
export function liveGuestCount(status: typeof state.collabStatus): number {
	return status.state === "live" ? status.participants.filter((p) => p.role === "guest").length : 0;
}

/**
 * Main-header "Live · N" badge, shown only while this session is shared
 * (collab status live); N is the guest count. Click opens the ShareSheet,
 * where the room is managed and stopped.
 */
export const LiveShareBadge = () => (
	<Show when={collabLive(state.collabStatus)}>
		<StatusSegment
			class="badge live-share-badge"
			title="Shared session: open the share sheet"
			onClick={openShareSheet}
		>
			Live · {liveGuestCount(state.collabStatus)}
		</StatusSegment>
	</Show>
);
