import { ReviewPanel } from "../../../web/components/review/ReviewPanel";
import { setState } from "../../../web/state";
import {
	gitCalls,
	reviewGitDiff,
	reviewGitDiffBinary,
	reviewGitStatusLarge,
	reviewGitStatusUnavailable,
} from "../../fixtures/review";
import { answerCalls } from "../../session";
import { defineStory } from "../../registry";

export default defineStory({
	id: "review-review-panel",
	title: "ReviewPanel",
	component: { file: "apps/web/components/review/ReviewPanel.tsx", export: "ReviewPanel" },
	seed: { capabilities: { git: { available: true } } },
	variants: [
		{
			name: "Changes",
			description:
				"Untracked, modified, and staged rows on feat/design-fixtures, with a commit message box. Hosted by the git dock.",
			seed: () => answerCalls(gitCalls()),
			render: () => (
				<div class="ds-frame-tall">
					<ReviewPanel />
				</div>
			),
		},
		{
			name: "Diff open",
			description: "A single-hunk diff of CopyButton.tsx open in the diff viewer.",
			seed: () => {
				answerCalls(gitCalls());
				setState("review", "fileDiff", reviewGitDiff);
			},
			render: () => (
				<div class="ds-frame-tall">
					<ReviewPanel />
				</div>
			),
		},
		{
			name: "Binary asset",
			description: "A staged font file, shown with the binary placeholder instead of text.",
			seed: () => {
				answerCalls(gitCalls());
				setState("review", "fileDiff", reviewGitDiffBinary);
			},
			render: () => (
				<div class="ds-frame-tall">
					<ReviewPanel />
				</div>
			),
		},
		{
			name: "Large worktree",
			description:
				"2000 untracked build-output paths and 100 staged ones. Only the rows near each list's viewport are mounted.",
			seed: () => answerCalls(gitCalls({ status: reviewGitStatusLarge })),
			render: () => (
				<div class="ds-frame-tall">
					<ReviewPanel />
				</div>
			),
		},
		{
			name: "Not a repository",
			description:
				"The working directory is not a git repository, so the panel shows the reason row.",
			seed: () => answerCalls(gitCalls({ status: reviewGitStatusUnavailable })),
			render: () => (
				<div class="ds-frame-tall">
					<ReviewPanel />
				</div>
			),
		},
		{
			name: "Status error",
			description: "git refused the status call because the index is locked.",
			seed: () =>
				answerCalls(gitCalls({ statusError: "index.lock exists; another git process is running" })),
			render: () => (
				<div class="ds-frame-tall">
					<ReviewPanel />
				</div>
			),
		},
		{
			name: "Loading",
			description: "The status request is still in flight.",
			seed: () => answerCalls(gitCalls({ pending: true })),
			render: () => (
				<div class="ds-frame-tall">
					<ReviewPanel />
				</div>
			),
		},
	],
});
