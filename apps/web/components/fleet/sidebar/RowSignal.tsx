import { Show, type Component } from "solid-js";
import type { SessionStatus } from "#lib/wire/protocol";
import type { SessionActivity } from "../../../fleet-ui/session-activity";

// ---------------------------------------------------------------------------
// The corner signal shared by a roster row and a collapsed group's summary:
// one visual per job, so a row and the group that hides it read identically.
//   spinner: the session is working (activity in_progress), its process is
//            on its way up (spawning/connecting), or the row is waking after
//            a click (`waking`, web-only). Green comet ring for working,
//            accent comet ring for starting.
//   dot:     something needs a look: blocked (red), error (red),
//            reconnecting (amber), unreviewed and unread (light blue).
//   nothing: ready + idle and asleep. A ready row is marked by the right-edge
//            rail instead (.sidebar-list --ready-rail-*), never by a dot.
// Styling is the .session-status-dot family in fleet.css, keyed by data-status
// and data-activity.
// ---------------------------------------------------------------------------

/** A roster status, or `waking`: the row was activated and its session is not ready yet (web-only, never on the wire). */
export type RowSignalStatus = SessionStatus | "waking";

/** Statuses that show the starting spinner. */
const TRANSITIONAL: Partial<Record<RowSignalStatus, true>> = {
	spawning: true,
	connecting: true,
	waking: true,
};

/** Attributes of the signal element, or undefined when nothing shows. */
function signalAttrs(
	status: RowSignalStatus,
	activity: SessionActivity | undefined,
): { status: RowSignalStatus; activity?: SessionActivity } | undefined {
	if (TRANSITIONAL[status]) return { status, activity: "in_progress" };
	if (status === "reconnecting" || status === "error") return { status };
	if (status !== "ready" || activity === undefined || activity === "idle") return undefined;
	return { status, activity };
}

export const RowSignal: Component<{ status: RowSignalStatus; activity?: SessionActivity }> = (
	props,
) => (
	<Show when={signalAttrs(props.status, props.activity)}>
		{(attrs) => (
			<span
				class="session-status-dot"
				data-status={attrs().status}
				data-activity={attrs().activity}
			/>
		)}
	</Show>
);
