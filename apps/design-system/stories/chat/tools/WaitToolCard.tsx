import { WaitToolCard } from "../../../../web/components/chat/tools/WaitToolCard";
import { answerCalls } from "../../../session";
import { seedJobWidgets, benchEntry } from "../../../fixtures/job-bars";
import { waitWidgetsTool } from "../../../fixtures/job-widgets";
import {
	waitAgentsTool,
	waitIdleTool,
	waitJobDetail,
	waitLiveRunTools,
	waitManyTool,
	waitRunTools,
	waitRunningTool,
	waitSettledTool,
} from "../../../fixtures/tools";
import { defineStory } from "../../../registry";

/** Opening a row asks the session for the job's output tail; the story answers it. */
function answerJobDetail(): void {
	answerCalls({ getJobDetail: () => structuredClone(waitJobDetail) });
}

export default defineStory({
	id: "chat-tools-wait-tool-card",
	title: "WaitToolCard",
	component: { file: "apps/web/components/chat/tools/WaitToolCard.tsx", export: "WaitToolCard" },
	variants: [
		{
			name: "Running, live rows",
			description:
				"One call in flight: a subagent with its stage and completion ring, a bash job and an eval job. The dots pulse and the clocks tick; the eval job's row glances its live widget.",
			seed: () => {
				seedJobWidgets(1, [benchEntry()]);
				answerJobDetail();
			},
			render: () => <WaitToolCard calls={[waitRunningTool]} />,
		},
		{
			name: "Live run of two waits",
			description:
				"A run still going: the first wait settled with the build done, the last is in flight. The build keeps its earlier outcome while the other jobs run; the header counts all of them and the bar fills in proportion. Rows open on click (the output tail loads once).",
			seed: answerJobDetail,
			render: () => <WaitToolCard calls={waitLiveRunTools} />,
		},
		{
			name: "Settled run of four waits",
			description:
				"Four consecutive waits, one card. Each job shows the state of the latest wait that listed it: the build settled in the first wait and later waits stop listing it; the tests failed (exit 1) in the third; the second wait was interrupted by a message, which the muted footer notes. Failed sorts first, then the most recently settled.",
			seed: answerJobDetail,
			render: () => <WaitToolCard calls={waitRunTools} />,
		},
		{
			name: "Settled, mixed outcomes",
			description:
				"One wait: done, failed (with its exit code) and cancelled jobs sort after the running ones; subagents with no job row list below the rows.",
			render: () => <WaitToolCard calls={[waitSettledTool]} />,
		},
		{
			name: "Settled, with job widgets",
			description:
				"Each row glances its job's widget as the settled result kept it: a benchmark's headline and chart, a subagent's figure, a failed run's headline. A running job with a basic widget shows its stage; a settled basic widget and a job with no widget draw only the line. Open a row for the whole widget.",
			seed: answerJobDetail,
			render: () => <WaitToolCard calls={[waitWidgetsTool]} />,
		},
		{
			name: "Many jobs, eight rows",
			description:
				"Eleven watched jobs: eight rows, then a +3 more control that opens the jobs list. A row you open stays visible.",
			render: () => <WaitToolCard calls={[waitManyTool]} />,
		},
		{
			name: "Agents only",
			description: "No job, but two running agents: each keeps a compact row.",
			render: () => <WaitToolCard calls={[waitAgentsTool]} />,
		},
		{
			name: "Nothing to wait for",
			description: "No job to show: the result text stands in.",
			render: () => <WaitToolCard calls={[waitIdleTool]} />,
		},
	],
});
