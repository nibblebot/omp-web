import { QueueBar } from "../../../../web/components/chat/composer/QueueBar";
import { setState } from "../../../../web/state";
import { answerCalls } from "../../../session";
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
			name: "Compaction queued for turn end",
			description:
				"/compact sent with the follow-up key mid-turn waits as a command chip and runs when the turn yields; a follow-up sent after it is held behind it and labelled as a follow-up.",
			seed: () => {
				answerCalls({
					getQueuedMessages: () => ({
						...screenQueuedMessages,
						commands: ["/compact soft keep the auth refactor", "Then update the changelog"],
					}),
				});
				setState({ streaming: true, queuedMessageCount: queuedCount + 2 });
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
		{
			name: "Queued images and text files",
			description:
				"A queued steer carries a text file and an image; a queued follow-up carries two images. Files show by name, images as a count.",
			seed: () => {
				answerCalls({
					getQueuedMessages: () => ({
						steering: ['Match the attached spec\n\n<file path="spec.md">\n# Spec\n</file>'],
						steeringImageCounts: [1],
						followUp: ["Check these screenshots"],
						followUpImageCounts: [2],
						liveSteered: 0,
						paused: [],
					}),
				});
				setState({ streaming: true, queuedMessageCount: 2 });
			},
			render: () => (
				<div class="ds-frame">
					<QueueBar />
				</div>
			),
		},
	],
});
