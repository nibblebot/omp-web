import { CompactionDialog } from "../../../../web/components/chat/controls/CompactionDialog";
import { setState } from "../../../../web/state";
import { selectCompactionMode, setCompactionFocus } from "../../../../web/store/compaction";
import {
	compactionSnapshotReady,
	compactionSnapshotRemoteBlocked,
} from "../../../fixtures/dialogs";
import { answerCalls } from "../../../daemon";
import { defineStory } from "../../../registry";

const ready = (): void => answerCalls({ compactionSnapshot: () => compactionSnapshotReady });

export default defineStory({
	id: "chat-controls-compaction-dialog",
	title: "CompactionDialog",
	component: {
		file: "apps/web/components/chat/controls/CompactionDialog.tsx",
		export: "CompactionDialog",
	},
	tabs: true,
	variants: [
		{
			name: "Ready, soft selected",
			seed: ready,
			render: (ctx) => <CompactionDialog onClose={ctx.close} />,
		},
		{
			name: "Remote refused on this route",
			seed: () => {
				answerCalls({ compactionSnapshot: () => compactionSnapshotRemoteBlocked });
				selectCompactionMode("remote");
			},
			render: (ctx) => <CompactionDialog onClose={ctx.close} />,
		},
		{
			name: "Snapcompact rejects focus text",
			seed: () => {
				ready();
				selectCompactionMode("snapcompact");
				setCompactionFocus("keep the vitest migration notes");
			},
			render: (ctx) => <CompactionDialog onClose={ctx.close} />,
		},
		{
			name: "Compaction running",
			seed: () => {
				answerCalls({ compactionSnapshot: () => ({ ...compactionSnapshotReady, active: true }) });
				setState("compaction", "progress", { phase: "running", startedAt: Date.now() - 12_000 });
			},
			render: (ctx) => <CompactionDialog onClose={ctx.close} />,
		},
		{
			name: "Compaction finished",
			seed: () => {
				ready();
				setState("compaction", "progress", { phase: "done" });
				setState("compaction", "preEstimate", { usedTokens: 142_000, contextWindow: 200_000 });
				setState("compaction", "postEstimate", { usedTokens: 58_400, contextWindow: 200_000 });
				setState("compaction", "result", {
					mode: "soft",
					summary:
						"Overlay stories: AskDialog, SessionGraphDialog, and BtwSheet covered. Remaining: DownloadDialog consent phase.",
					firstKeptEntryId: "n06",
					tokensBefore: 142_000,
					tokensAfterEstimate: 58_400,
					historyRetained: true,
				});
			},
			render: (ctx) => <CompactionDialog onClose={ctx.close} />,
		},
		{
			name: "Snapshot failed",
			seed: () => {
				answerCalls({
					compactionSnapshot: () => {
						throw new Error("compaction service unavailable: daemon d_7f3a is busy");
					},
				});
			},
			render: (ctx) => <CompactionDialog onClose={ctx.close} />,
		},
		{
			name: "Maintenance finished",
			seed: () => {
				ready();
				setState("compaction", "shake", {
					phase: "done",
					summary: "Dropped 14 tool results and 3 thinking blocks",
					tokensFreed: 21_300,
					removed: 17,
				});
			},
			render: (ctx) => <CompactionDialog onClose={ctx.close} />,
		},
	],
});
