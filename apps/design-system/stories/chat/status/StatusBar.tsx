import { StatusBar } from "../../../../web/components/chat";
import { setState } from "../../../../web/state";
import { subagentMap } from "../../../fixtures/session";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "chat-status-bar",
	title: "StatusBar",
	component: { file: "apps/web/components/chat/status/StatusBar.tsx", export: "StatusBar" },
	seed: { connected: true },
	variants: [
		{
			name: "Idle",
			description: "Connected with nothing to report: the bar renders no segments.",
			render: () => <StatusBar />,
		},
		{
			name: "Compacting with queue",
			seed: { compacting: true, queuedMessageCount: 2 },
			render: () => <StatusBar />,
		},
		{
			name: "Goal, plan mode, subagents",
			seed: {
				goal: { objective: "Ship the design system showcase" },
				planModeEnabled: true,
				subagents: subagentMap,
			},
			render: () => <StatusBar />,
		},
		{
			name: "Auto-retry countdown",
			// Function seed: `until` must be relative to the moment of seeding.
			seed: () =>
				setState("retryInfo", {
					attempt: 2,
					maxAttempts: 5,
					delayMs: 8000,
					until: Date.now() + 8000,
				}),
			render: () => <StatusBar />,
		},
	],
});
