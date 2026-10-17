import { VibePanel } from "../../../../web/components/chat/controls/VibePanel";
import { seedSubagents, vibeDisabled, vibeEnabled } from "../../../fixtures/subagents";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "chat-controls-vibe-panel",
	title: "VibePanel",
	component: { file: "apps/web/components/chat/controls/VibePanel.tsx", export: "VibePanel" },
	variants: [
		{
			name: "Disabled",
			seed: () => seedSubagents({ vibeStatus: () => vibeDisabled }),
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<VibePanel />
				</div>
			),
		},
		{
			name: "Enabled with workers",
			seed: () => seedSubagents({ vibeStatus: () => vibeEnabled }),
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<VibePanel />
				</div>
			),
		},
	],
});
