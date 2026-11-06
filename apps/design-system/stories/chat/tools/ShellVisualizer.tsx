import { ShellVisualizer } from "../../../../web/components/chat/tools/ShellVisualizer";
import { forgetShellVizUnavailable } from "../../../../web/store/shell-viz";
import { answerCalls } from "../../../session";
import {
	shellVizAnswers,
	shellVizCalls,
	shellVizDoneTool,
	shellVizFailedTool,
	shellVizNoTraceTool,
	shellVizRunningTool,
	shellVizTruncatedTool,
	shellVizUnmarkedTool,
} from "../../../fixtures/shell-viz";
import { defineStory } from "../../../registry";
import type { ToolItem } from "../../../../web/state";

const frame = (item: ToolItem) => (
	<div class="ds-frame">
		<ShellVisualizer item={item} />
	</div>
);

const seed = () => {
	forgetShellVizUnavailable();
	answerCalls(shellVizCalls(shellVizAnswers));
};

export default defineStory({
	id: "chat-tools-shell-visualizer",
	title: "ShellVisualizer",
	component: {
		file: "apps/web/components/chat/tools/ShellVisualizer.tsx",
		export: "ShellVisualizer",
	},
	variants: [
		{
			name: "Pseudo",
			description:
				"Closed, nothing fetched or mounted. Click Visualize: the card asks the session for the call's visualization once, then draws the Pseudo tab.",
			seed,
			render: () => frame(shellVizDoneTool),
		},
		{
			name: "Failure",
			description: "A failed build: failed commands carry the × mark and their exit status.",
			seed,
			render: () => frame(shellVizFailedTool),
		},
		{
			name: "Truncated",
			description:
				"The session cut a huge script to fit the answer and says how many rows it left out.",
			seed,
			render: () => frame(shellVizTruncatedTool),
		},
		{
			name: "Running",
			description:
				"A call still running: the open view refreshes while the call runs, with the executing statement marked.",
			seed,
			render: () => frame(shellVizRunningTool),
		},
		{
			name: "Unavailable",
			description:
				"A marked result the session can no longer answer for: opening it hides the control for good.",
			seed,
			render: () => frame(shellVizNoTraceTool),
		},
		{
			name: "No shell trace marker",
			description:
				"A settled result without the session's `details.shellTrace` marker (a session from before SDK 18.17.0): no control at all, nothing to ask for.",
			seed,
			render: () => frame(shellVizUnmarkedTool),
		},
		{
			name: "Load failure",
			description: "The call could not be made: the body says so and offers a retry.",
			seed: () => {
				forgetShellVizUnavailable();
				answerCalls({
					getShellVisualization: () => {
						throw new Error("Connection lost");
					},
				});
			},
			render: () => frame(shellVizDoneTool),
		},
	],
});
