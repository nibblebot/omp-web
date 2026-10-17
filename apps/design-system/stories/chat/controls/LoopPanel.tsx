import { LoopPanel } from "../../../../web/components/chat/controls/LoopPanel";
import {
	ClickOnMount,
	goalActive,
	loopPolicyIdle,
	loopPolicyPaused,
	loopPolicyRunning,
	loopPolicyStopped,
	seedSubagents,
} from "../../../fixtures/subagents";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "chat-controls-loop-panel",
	title: "LoopPanel",
	component: { file: "apps/web/components/chat/controls/LoopPanel.tsx", export: "LoopPanel" },
	variants: [
		{
			name: "Idle, bounded loop ready",
			seed: () => seedSubagents({ loopPolicy: () => loopPolicyIdle }, { goalModeState: undefined }),
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<LoopPanel />
				</div>
			),
		},
		{
			name: "Preview shown",
			seed: () => seedSubagents({ loopPolicy: () => loopPolicyIdle }, { goalModeState: undefined }),
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<ClickOnMount labels={["preview"]}>
						<LoopPanel />
					</ClickOnMount>
				</div>
			),
		},
		{
			name: "Running, next iteration scheduled",
			seed: () =>
				seedSubagents({ loopPolicy: () => loopPolicyRunning }, { goalModeState: undefined }),
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<LoopPanel />
				</div>
			),
		},
		{
			name: "Paused",
			seed: () =>
				seedSubagents({ loopPolicy: () => loopPolicyPaused }, { goalModeState: undefined }),
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<LoopPanel />
				</div>
			),
		},
		{
			name: "Stopped at limit",
			seed: () =>
				seedSubagents({ loopPolicy: () => loopPolicyStopped }, { goalModeState: undefined }),
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<LoopPanel />
				</div>
			),
		},
		{
			name: "Goal active, start blocked",
			seed: () =>
				seedSubagents({ loopPolicy: () => loopPolicyIdle }, { goalModeState: goalActive }),
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<LoopPanel />
				</div>
			),
		},
	],
});
