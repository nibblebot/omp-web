import { QueueBar } from "../../../../web/components/chat/composer/QueueBar";
import { setState } from "../../../../web/state";
import { answerCalls } from "../../../daemon";
import {
	screenPausedQueue,
	screenQueuedMessages,
	screenSessionSeed,
} from "../../../fixtures/screen";
import { defineStory } from "../../../registry";

const queuedCount = screenQueuedMessages.steering.length + screenQueuedMessages.followUp.length;

export default defineStory({
	id: "chat-composer-queue-bar",
	title: "QueueBar",
	component: { file: "apps/web/components/chat/composer/QueueBar.tsx", export: "QueueBar" },
	seed: screenSessionSeed,
	variants: [
		{
			name: "Nothing queued",
			description: "Idle session; the bar stays hidden.",
			seed: { streaming: false, queuedMessageCount: 0 },
			render: () => (
				<div class="ds-frame">
					<QueueBar />
				</div>
			),
		},
		{
			name: "Steering and follow-ups queued",
			description: "Messages waiting while the agent works, listed as chips.",
			seed: () => {
				answerCalls({ getQueuedMessages: () => screenQueuedMessages });
				setState({ streaming: true, queuedMessageCount: queuedCount });
			},
			render: () => (
				<div class="ds-frame">
					<QueueBar />
				</div>
			),
		},
		{
			name: "Slash command queued while busy",
			description:
				"A forwarded command the SDK refused mid-turn waits as a chip with run now and delete; it runs at turn end.",
			seed: () => {
				answerCalls({
					getQueuedMessages: () => ({ ...screenQueuedMessages, commands: ["/add-dir /tmp/extra"] }),
				});
				setState({ streaming: true, queuedMessageCount: queuedCount + 1 });
			},
			render: () => (
				<div class="ds-frame">
					<QueueBar />
				</div>
			),
		},
		{
			name: "Paused after Stop",
			description:
				"Stop held the queue: chips are paused, with Resume queue to send them in order.",
			seed: () => {
				answerCalls({ getQueuedMessages: () => screenPausedQueue });
				setState({ streaming: false, queuedMessageCount: 0, pausedQueueCount: 2 });
			},
			render: () => (
				<div class="ds-frame">
					<QueueBar />
				</div>
			),
		},
	],
});
