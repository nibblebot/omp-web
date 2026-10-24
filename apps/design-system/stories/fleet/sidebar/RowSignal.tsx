import type { DaemonStatus } from "#lib/wire/protocol";
import { RowSignal } from "../../../../web/components/fleet/sidebar/RowSignal";
import type { SessionActivity } from "../../../../web/fleet-ui/session-activity";
import { defineStory } from "../../../registry";

/** The signal in the sidebar's corner-slot wrapper, so the dot and spinner take their row sizing. */
const Signal = (props: { status: DaemonStatus; activity?: SessionActivity }) => (
	<div class="ds-frame-sidebar">
		<div class="sidebar-list">
			<span class="daemon-row-status">
				<RowSignal status={props.status} activity={props.activity} />
			</span>
		</div>
	</div>
);

export default defineStory({
	id: "fleet-sidebar-row-signal",
	title: "RowSignal",
	component: { file: "apps/web/components/fleet/sidebar/RowSignal.tsx", export: "RowSignal" },
	variants: [
		{
			name: "Ready, idle (nothing)",
			description:
				"Renders nothing: a ready idle row is marked by its right-edge rail, never by a dot. An asleep row also renders nothing.",
			render: () => <Signal status="ready" activity="idle" />,
		},
		{
			name: "Working (spinner)",
			description: "A ready session mid-turn: a green comet ring.",
			render: () => <Signal status="ready" activity="in_progress" />,
		},
		{
			name: "Starting (spinner)",
			description: "The process is on its way up (resolving): an accent comet ring.",
			render: () => <Signal status="resolving" />,
		},
		{
			name: "Blocked (dot)",
			description: "Waiting on an extension dialog: a red dot.",
			render: () => <Signal status="ready" activity="blocked" />,
		},
		{
			name: "Unreviewed (dot)",
			description: "A turn ended below the viewport: a light blue dot, the same as unread.",
			render: () => <Signal status="ready" activity="unreviewed" />,
		},
		{
			name: "Unread (dot)",
			description: "A turn finished while another session was in view: a light blue dot.",
			render: () => <Signal status="ready" activity="unread" />,
		},
		{
			name: "Reconnecting (dot)",
			description: "The session socket dropped and is redialing: an amber dot.",
			render: () => <Signal status="reconnecting" />,
		},
		{
			name: "Error (dot)",
			description: "The session process failed: a red dot.",
			render: () => <Signal status="error" />,
		},
	],
});
