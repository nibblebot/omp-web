import { LiveShareBadge } from "../../../../web/components/chat/status/LiveShareBadge";
import { COLLAB_OFF } from "../../../../web/store/slices/collab";
import { liveCollabStatus } from "../../../fixtures/collab";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "chat-status-live-share-badge",
	title: "LiveShareBadge",
	component: {
		file: "apps/web/components/chat/status/LiveShareBadge.tsx",
		export: "LiveShareBadge",
	},
	variants: [
		{
			name: "Shared live",
			description:
				"Header badge while the session is shared: Live and the guest count. Clicking opens the ShareSheet.",
			seed: { collabStatus: liveCollabStatus },
			render: () => <LiveShareBadge />,
		},
		{
			name: "Not shared",
			description:
				"Renders nothing unless the room is live; Share session in the palette starts one.",
			seed: { collabStatus: COLLAB_OFF },
			render: () => <LiveShareBadge />,
		},
	],
});
