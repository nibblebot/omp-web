import { ShareSheet } from "../../../web/components/collab/ShareSheet";
import { COLLAB_OFF } from "../../../web/store/slices/collab";
import { liveCollabStatus as liveStatus } from "../../fixtures/collab";
import { defineStory } from "../../registry";

export default defineStory({
	id: "collab-share-sheet",
	title: "ShareSheet",
	component: {
		file: "apps/web/components/collab/ShareSheet.tsx",
		export: "ShareSheet",
	},
	tabs: true,
	variants: [
		{
			name: "Not sharing, no relay configured",
			description: "The public relay opt-in and its disclosure show before any click.",
			seed: { modal: "share", collabStatus: COLLAB_OFF },
			render: (ctx) => <ShareSheet onClose={ctx.close} />,
		},
		{
			name: "Starting",
			seed: { modal: "share", collabStatus: { state: "starting" } },
			render: (ctx) => <ShareSheet onClose={ctx.close} />,
		},
		{
			name: "Live with guests",
			description:
				"Control and view links, the browser link QR, the omp join command, and the roster.",
			seed: { modal: "share", collabStatus: liveStatus },
			render: (ctx) => <ShareSheet onClose={ctx.close} />,
		},
		{
			name: "Start failed",
			seed: {
				modal: "share",
				collabStatus: { state: "error", error: "relay wss://relay.example refused the room" },
			},
			render: (ctx) => <ShareSheet onClose={ctx.close} />,
		},
	],
});
