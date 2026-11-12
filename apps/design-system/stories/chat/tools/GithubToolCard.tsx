import { GithubToolCard } from "../../../../web/components/chat/tools/GithubToolCard";
import {
	githubSearchPrsTool,
	githubWatchCommitTool,
	githubWatchFailedTool,
	githubWatchPassedTool,
	githubWatchRunningTool,
	githubWatchWaitingTool,
} from "../../../fixtures/github-watch";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "chat-tools-github-tool-card",
	title: "GithubToolCard",
	component: {
		file: "apps/web/components/chat/tools/GithubToolCard.tsx",
		export: "GithubToolCard",
	},
	variants: [
		{
			name: "Watch running, mid-job",
			description:
				"An Actions run watch in flight, as the last poll reported it: lint and types passed (closed), the test job runs on its fifth step (open, the running step spins) and the build is queued. Durations are the SDK's, cut at that poll.",
			render: () => <GithubToolCard item={githubWatchRunningTool} />,
		},
		{
			name: "Watch running, before the first poll",
			description: "The call started and no snapshot has arrived yet.",
			render: () => <GithubToolCard item={githubWatchWaitingTool} />,
		},
		{
			name: "Watch succeeded",
			description:
				"The settled watch: every job passed, so every job is closed. Open one for its ordered steps with state and duration.",
			render: () => <GithubToolCard item={githubWatchPassedTool} />,
		},
		{
			name: "Watch with a failed step",
			description:
				"The failed step is a tinted row inside its open job, later steps are skipped, the cancelled build keeps its own icon, and the failed job's captured log tail sits under the runs, closed.",
			render: () => <GithubToolCard item={githubWatchFailedTool} />,
		},
		{
			name: "Commit watch, two runs",
			description:
				"A watch scoped to a branch's commit lists each workflow run of it, here one running and one passed.",
			render: () => <GithubToolCard item={githubWatchCommitTool} />,
		},
		{
			name: "Other op, generic card",
			description: "Every op other than run_watch draws the generic tool card.",
			render: () => <GithubToolCard item={githubSearchPrsTool} />,
		},
	],
});
