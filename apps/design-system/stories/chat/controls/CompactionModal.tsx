import { CompactionModal } from "../../../../web/components/chat/controls/CompactionModal";
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
	id: "chat-controls-compaction-modal",
	title: "CompactionModal",
	component: {
		file: "apps/web/components/chat/controls/CompactionModal.tsx",
		export: "CompactionModal",
	},
	tabs: true,
	variants: [
		{
			name: "Ready, soft selected",
			seed: ready,
			render: () => <CompactionModal onClose={() => {}} />,
		},
		{
			name: "Remote refused on this route",
			seed: () => {
				answerCalls({ compactionSnapshot: () => compactionSnapshotRemoteBlocked });
				selectCompactionMode("remote");
			},
			render: () => <CompactionModal onClose={() => {}} />,
		},
		{
			name: "Snapcompact rejects focus text",
			seed: () => {
				ready();
				selectCompactionMode("snapcompact");
				setCompactionFocus("keep the vitest migration notes");
			},
			render: () => <CompactionModal onClose={() => {}} />,
		},
		{
			name: "Compaction running",
			seed: () => {
				answerCalls({ compactionSnapshot: () => ({ ...compactionSnapshotReady, active: true }) });
				setState("compaction", "progress", { phase: "running", startedAt: Date.now() - 12_000 });
			},
			render: () => <CompactionModal onClose={() => {}} />,
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
						"Overlay stories: AskDialog, SessionGraphModal, and BtwPanel covered. Remaining: DownloadDialog consent phase.",
					firstKeptEntryId: "n06",
					tokensBefore: 142_000,
					tokensAfterEstimate: 58_400,
					historyRetained: true,
				});
			},
			render: () => <CompactionModal onClose={() => {}} />,
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
			render: () => <CompactionModal onClose={() => {}} />,
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
			render: () => <CompactionModal onClose={() => {}} />,
		},
	],
});
