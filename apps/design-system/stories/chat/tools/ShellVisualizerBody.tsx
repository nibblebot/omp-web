import { ShellVisualizerBody } from "../../../../web/components/chat/tools/ShellVisualizerBody";
import { forgetShellVizUnavailable } from "../../../../web/store/shell-viz";
import {
	shellVizAnswers,
	shellVizCalls,
	shellVizDoneTool,
	shellVizRunningTool,
} from "../../../fixtures/shell-viz";
import { answerCalls } from "../../../session";
import { defineStory } from "../../../registry";
import type { ToolItem } from "../../../../web/state";

const frame = (item: ToolItem) => (
	<div class="ds-frame">
		<ShellVisualizerBody item={item} subagentId={undefined} onUnavailable={() => undefined} />
	</div>
);

const seed = () => {
	forgetShellVizUnavailable();
	answerCalls(shellVizCalls(shellVizAnswers));
};

export default defineStory({
	id: "chat-tools-shell-visualizer-body",
	title: "ShellVisualizerBody",
	component: {
		file: "apps/web/components/chat/tools/ShellVisualizerBody.tsx",
		export: "ShellVisualizerBody",
	},
	variants: [
		{
			name: "Settled call",
			description:
				"The body of an opened Visualize, loaded in its own chunk: it asks the session for the call's visualization once and draws it.",
			seed,
			render: () => frame(shellVizDoneTool),
		},
		{
			name: "Running",
			description:
				"A call still running: the body refreshes while it runs, with the executing statement marked.",
			seed,
			render: () => frame(shellVizRunningTool),
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
