import { RetryBadge } from "../../../../web/components/chat/status/RetryBadge";
import { setState } from "../../../../web/state";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "chat-status-retry-badge",
	title: "RetryBadge",
	component: { file: "apps/web/components/chat/status/RetryBadge.tsx", export: "RetryBadge" },
	variants: [
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
			render: () => <RetryBadge />,
		},
	],
});
