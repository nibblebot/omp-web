import { App } from "../../../web/App";
import { setState } from "../../../web/state";
import { answerCalls } from "../../daemon";
import { belowEditorRequest } from "../../fixtures/dialogs";
import { askUiRequest } from "../../fixtures/overlays";
import {
	screenItems,
	screenLiveBlocks,
	screenQueuedMessages,
	screenSessionSeed,
	screenStreamingItems,
	screenWorkingIntent,
} from "../../fixtures/screen";
import { defineStory } from "../../registry";

const queuedCount = screenQueuedMessages.steering.length + screenQueuedMessages.followUp.length;

export default defineStory({
	id: "app",
	title: "App",
	component: { file: "apps/web/App.tsx", export: "App" },
	seed: { ...screenSessionSeed, items: screenItems, streaming: false },
	variants: [
		{
			name: "Active conversation",
			description: "A finished turn in a live session, with the prompt box docked at the bottom.",
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<App />
				</div>
			),
		},
		{
			name: "Streaming with queue",
			description: "A turn is running, with a steering message and follow-ups waiting.",
			seed: () => {
				answerCalls({ getQueuedMessages: () => screenQueuedMessages });
				setState({
					items: screenStreamingItems,
					live: { active: true, blocks: screenLiveBlocks, rev: 1 },
					streaming: true,
					workingIntent: screenWorkingIntent,
					queuedMessageCount: queuedCount,
				});
			},
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<App />
				</div>
			),
		},
		{
			name: "Agent asks a question",
			description: "A pending ask from the agent: ModalHost's AskDialog opens over the screen.",
			seed: { uiRequest: askUiRequest },
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<App />
				</div>
			),
		},
		{
			name: "Extension widget below the editor",
			description: "A browser_ui widget placed belowEditor renders in the composer slot.",
			seed: { browserUi: { requests: [belowEditorRequest], error: null } },
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<App />
				</div>
			),
		},
		{
			name: "No active session",
			description: "The daemon is connected but no session is attached.",
			seed: { currentSessionId: "", items: [] },
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<App />
				</div>
			),
		},
		{
			name: "Fleet required",
			description: "The fleet gate blocks the app until a daemon fleet is available.",
			seed: { fleetRequired: true },
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<App />
				</div>
			),
		},
	],
});
