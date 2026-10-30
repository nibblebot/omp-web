import type { JSX } from "solid-js";
import { customEntryOf } from "../../../../../web/tx/util/entries";
import {
	createCollapseStore,
	RowStateCtx,
} from "../../../../../web/tx/components/transcript/collapse";
import { pairToolCalls } from "../../../../../web/tx/components/transcript/pairing";
import { TranscriptEntryRow } from "../../../../../web/tx/components/transcript/rows/entry-row";
import {
	AssistantMessageRow,
	DeveloperMessageRow,
	FileMentionRow,
	ToolResultRow,
	UserMessageRow,
} from "../../../../../web/tx/components/transcript/rows/messages";
import {
	DataKeyValue,
	SystemRow,
	KeyValue,
	RawJson,
	SystemCard,
	ToggleDetails,
} from "../../../../../web/tx/components/transcript/rows/shared";
import {
	CompactionRow,
	CustomMessageRow,
	CustomRow,
	GoalCompletedRow,
	ModeChangeRow,
	SessionExitRow,
	SessionHeaderRow,
	SessionInitRow,
	TitleChangeRow,
	TtsrInjectionRow,
} from "../../../../../web/tx/components/transcript/rows/system";
import {
	assistantErrorEntry,
	assistantPendingEntry,
	assistantRichEntry,
	bashErrorResultEntry,
	compactionEntry,
	customDataEntry,
	customMessageEntry,
	customMessageHiddenEntry,
	customUnknownEntry,
	developerEntry,
	emptyPairing,
	fileMentionEntry,
	finalAssistantEntry,
	goalCompletedEntry,
	labelEntry,
	longToolResultEntry,
	modeChangeEntry,
	modelChangeEntry,
	pendingStartEntry,
	prunedToolResultEntry,
	sessionExitEntry,
	sessionHeaderEntry,
	sessionInitEntry,
	titleChangeEntry,
	toolResultEntry,
	transcriptPairing,
	ttsrInjectionEntry,
	unknownTypeEntry,
	userEntry,
	userImageEntry,
} from "../../../../fixtures/tx";
import { defineStory } from "../../../../registry";

/**
 * Rows read their collapse state through RowStateCtx, which TranscriptView
 * normally provides. `initialExpanded` forces every details/card open for the
 * expanded variants.
 */
function RowHost(props: { initialExpanded?: boolean; children: JSX.Element }) {
	const store = createCollapseStore();
	if (props.initialExpanded) store.expandEverything();
	return <RowStateCtx.Provider value={store.ctx}>{props.children}</RowStateCtx.Provider>;
}

const goalData = customEntryOf(goalCompletedEntry)?.data ?? null;
const exitData = customEntryOf(sessionExitEntry)?.data ?? null;
const pendingPairing = pairToolCalls([pendingStartEntry, assistantPendingEntry]);

export default [
	// ---- shared.tsx primitives ----
	defineStory({
		id: "tx-transcript-rows-toggle-details",
		title: "ToggleDetails",
		component: {
			file: "apps/web/tx/components/transcript/rows/shared.tsx",
			export: "ToggleDetails",
		},
		variants: [
			{
				name: "Collapsed",
				render: () => (
					<RowHost>
						<ToggleDetails entry={userEntry} purpose="demo" summary="tool arguments">
							<pre>{'{ "path": "apps/web/store/fleet-api.ts", "limit": 80 }'}</pre>
						</ToggleDetails>
					</RowHost>
				),
			},
			{
				name: "Expanded",
				render: () => (
					<RowHost initialExpanded>
						<ToggleDetails entry={userEntry} purpose="demo" summary="tool arguments">
							<pre>{'{ "path": "apps/web/store/fleet-api.ts", "limit": 80 }'}</pre>
						</ToggleDetails>
					</RowHost>
				),
			},
		],
	}),
	defineStory({
		id: "tx-transcript-rows-raw-json",
		title: "RawJson",
		component: { file: "apps/web/tx/components/transcript/rows/shared.tsx", export: "RawJson" },
		variants: [
			{
				name: "Collapsed",
				render: () => (
					<RowHost>
						<RawJson entry={toolResultEntry} />
					</RowHost>
				),
			},
			{
				name: "Expanded",
				render: () => (
					<RowHost initialExpanded>
						<RawJson entry={toolResultEntry} />
					</RowHost>
				),
			},
		],
	}),
	defineStory({
		id: "tx-transcript-rows-system-card",
		title: "SystemCard",
		component: { file: "apps/web/tx/components/transcript/rows/shared.tsx", export: "SystemCard" },
		variants: [
			{
				name: "Header only",
				render: () => (
					<RowHost>
						<SystemCard entry={compactionEntry} label="compaction" />
					</RowHost>
				),
			},
			{
				name: "With body (expanded)",
				render: () => (
					<RowHost initialExpanded>
						<SystemCard entry={sessionInitEntry} label="session_init">
							<div>
								<KeyValue k="model" v="anthropic/claude-sonnet-5-5" />
								<KeyValue k="thinking" v="medium" />
								<KeyValue k="cwd" v="/home/joshua/Repos/omp-web" />
							</div>
						</SystemCard>
					</RowHost>
				),
			},
		],
	}),
	defineStory({
		id: "tx-transcript-rows-system-row",
		title: "SystemRow",
		component: {
			file: "apps/web/tx/components/transcript/rows/shared.tsx",
			export: "SystemRow",
		},
		variants: [
			{
				name: "Unknown entry type",
				render: () => (
					<RowHost>
						<SystemRow entry={unknownTypeEntry} label="future_entry" />
					</RowHost>
				),
			},
			{
				name: "Label with detail",
				render: () => (
					<RowHost>
						<SystemRow entry={labelEntry} label="label" detail="before-bulk-rename" />
					</RowHost>
				),
			},
		],
	}),
	defineStory({
		id: "tx-transcript-rows-key-value",
		title: "KeyValue",
		component: { file: "apps/web/tx/components/transcript/rows/shared.tsx", export: "KeyValue" },
		variants: [
			{
				name: "String, number and boolean values",
				render: () => (
					<div>
						<KeyValue k="provider" v="anthropic" />
						<KeyValue k="maxTokens" v={8192} />
						<KeyValue k="streaming" v={true} />
					</div>
				),
			},
			{
				name: "Missing value (row hidden)",
				render: () => (
					<div>
						<KeyValue k="provider" v="anthropic" />
						<KeyValue k="serviceTier" v={undefined} />
					</div>
				),
			},
		],
	}),
	defineStory({
		id: "tx-transcript-rows-data-key-value",
		title: "DataKeyValue",
		component: {
			file: "apps/web/tx/components/transcript/rows/shared.tsx",
			export: "DataKeyValue",
		},
		variants: [
			{
				name: "Scalar payload field",
				render: () => (
					<RowHost>
						<DataKeyValue
							k="objective"
							v="Migrate fleet registry to atomic writes"
							entry={goalCompletedEntry}
						/>
					</RowHost>
				),
			},
			{
				name: "Nested payload (collapsed JSON)",
				render: () => (
					<RowHost>
						<DataKeyValue
							k="usage"
							v={{ input: 48_213, output: 9_112, cacheRead: 31_804 }}
							entry={customDataEntry}
						/>
					</RowHost>
				),
			},
		],
	}),

	// ---- messages.tsx ----
	defineStory({
		id: "tx-transcript-rows-assistant-message-row",
		title: "AssistantMessageRow",
		component: {
			file: "apps/web/tx/components/transcript/rows/messages.tsx",
			export: "AssistantMessageRow",
		},
		variants: [
			{
				name: "Tool calls with paired results",
				render: () => (
					<RowHost>
						<AssistantMessageRow entry={assistantRichEntry} pairing={transcriptPairing} />
					</RowHost>
				),
			},
			{
				name: "Final answer",
				render: () => (
					<RowHost>
						<AssistantMessageRow entry={finalAssistantEntry} pairing={emptyPairing} />
					</RowHost>
				),
			},
			{
				name: "Pending tool call",
				render: () => (
					<RowHost>
						<AssistantMessageRow entry={assistantPendingEntry} pairing={pendingPairing} />
					</RowHost>
				),
			},
			{
				name: "Provider error",
				render: () => (
					<RowHost>
						<AssistantMessageRow entry={assistantErrorEntry} pairing={emptyPairing} />
					</RowHost>
				),
			},
		],
	}),
	defineStory({
		id: "tx-transcript-rows-user-message-row",
		title: "UserMessageRow",
		component: {
			file: "apps/web/tx/components/transcript/rows/messages.tsx",
			export: "UserMessageRow",
		},
		variants: [
			{
				name: "Text prompt",
				render: () => (
					<RowHost>
						<UserMessageRow entry={userEntry} />
					</RowHost>
				),
			},
			{
				name: "Prompt with pasted image",
				render: () => (
					<RowHost>
						<UserMessageRow entry={userImageEntry} />
					</RowHost>
				),
			},
		],
	}),
	defineStory({
		id: "tx-transcript-rows-tool-result-row",
		title: "ToolResultRow",
		component: {
			file: "apps/web/tx/components/transcript/rows/messages.tsx",
			export: "ToolResultRow",
		},
		variants: [
			{
				name: "Successful bash result",
				render: () => (
					<RowHost>
						<ToolResultRow entry={toolResultEntry} calls={transcriptPairing.calls} />
					</RowHost>
				),
			},
			{
				name: "Failed bash result",
				render: () => (
					<RowHost>
						<ToolResultRow entry={bashErrorResultEntry} calls={transcriptPairing.calls} />
					</RowHost>
				),
			},
			{
				name: "Long output",
				render: () => (
					<RowHost>
						<ToolResultRow entry={longToolResultEntry} calls={transcriptPairing.calls} />
					</RowHost>
				),
			},
			{
				name: "Pruned output",
				render: () => (
					<RowHost>
						<ToolResultRow entry={prunedToolResultEntry} calls={transcriptPairing.calls} />
					</RowHost>
				),
			},
		],
	}),
	defineStory({
		id: "tx-transcript-rows-developer-message-row",
		title: "DeveloperMessageRow",
		component: {
			file: "apps/web/tx/components/transcript/rows/messages.tsx",
			export: "DeveloperMessageRow",
		},
		variants: [
			{
				name: "System reminder",
				render: () => (
					<RowHost>
						<DeveloperMessageRow entry={developerEntry} />
					</RowHost>
				),
			},
		],
	}),
	defineStory({
		id: "tx-transcript-rows-file-mention-row",
		title: "FileMentionRow",
		component: {
			file: "apps/web/tx/components/transcript/rows/messages.tsx",
			export: "FileMentionRow",
		},
		variants: [
			{
				name: "Attached files",
				render: () => (
					<RowHost>
						<FileMentionRow entry={fileMentionEntry} />
					</RowHost>
				),
			},
		],
	}),

	// ---- system.tsx ----
	defineStory({
		id: "tx-transcript-rows-session-header-row",
		title: "SessionHeaderRow",
		component: {
			file: "apps/web/tx/components/transcript/rows/system.tsx",
			export: "SessionHeaderRow",
		},
		variants: [
			{
				name: "Session start",
				render: () => (
					<RowHost>
						<SessionHeaderRow entry={sessionHeaderEntry} />
					</RowHost>
				),
			},
		],
	}),
	defineStory({
		id: "tx-transcript-rows-session-init-row",
		title: "SessionInitRow",
		component: {
			file: "apps/web/tx/components/transcript/rows/system.tsx",
			export: "SessionInitRow",
		},
		variants: [
			{
				name: "Session init",
				render: () => (
					<RowHost>
						<SessionInitRow entry={sessionInitEntry} />
					</RowHost>
				),
			},
		],
	}),
	defineStory({
		id: "tx-transcript-rows-mode-change-row",
		title: "ModeChangeRow",
		component: {
			file: "apps/web/tx/components/transcript/rows/system.tsx",
			export: "ModeChangeRow",
		},
		variants: [
			{
				name: "Plan mode entered",
				render: () => (
					<RowHost>
						<ModeChangeRow entry={modeChangeEntry} />
					</RowHost>
				),
			},
		],
	}),
	defineStory({
		id: "tx-transcript-rows-title-change-row",
		title: "TitleChangeRow",
		component: {
			file: "apps/web/tx/components/transcript/rows/system.tsx",
			export: "TitleChangeRow",
		},
		variants: [
			{
				name: "Session renamed",
				render: () => (
					<RowHost>
						<TitleChangeRow entry={titleChangeEntry} />
					</RowHost>
				),
			},
		],
	}),
	defineStory({
		id: "tx-transcript-rows-ttsr-injection-row",
		title: "TtsrInjectionRow",
		component: {
			file: "apps/web/tx/components/transcript/rows/system.tsx",
			export: "TtsrInjectionRow",
		},
		variants: [
			{
				name: "Rule injected",
				render: () => (
					<RowHost>
						<TtsrInjectionRow entry={ttsrInjectionEntry} />
					</RowHost>
				),
			},
		],
	}),
	defineStory({
		id: "tx-transcript-rows-compaction-row",
		title: "CompactionRow",
		component: {
			file: "apps/web/tx/components/transcript/rows/system.tsx",
			export: "CompactionRow",
		},
		variants: [
			{
				name: "Context compacted",
				render: () => (
					<RowHost>
						<CompactionRow entry={compactionEntry} />
					</RowHost>
				),
			},
		],
	}),
	defineStory({
		id: "tx-transcript-rows-custom-message-row",
		title: "CustomMessageRow",
		component: {
			file: "apps/web/tx/components/transcript/rows/system.tsx",
			export: "CustomMessageRow",
		},
		variants: [
			{
				name: "Visible custom message",
				render: () => (
					<RowHost>
						<CustomMessageRow entry={customMessageEntry} />
					</RowHost>
				),
			},
			{
				name: "Hidden custom message",
				render: () => (
					<RowHost>
						<CustomMessageRow entry={customMessageHiddenEntry} />
					</RowHost>
				),
			},
		],
	}),
	defineStory({
		id: "tx-transcript-rows-custom-row",
		title: "CustomRow",
		component: { file: "apps/web/tx/components/transcript/rows/system.tsx", export: "CustomRow" },
		variants: [
			{
				name: "Custom payload",
				render: () => (
					<RowHost>
						<CustomRow entry={customDataEntry} />
					</RowHost>
				),
			},
			{
				name: "Unrecognized custom type",
				render: () => (
					<RowHost>
						<CustomRow entry={customUnknownEntry} />
					</RowHost>
				),
			},
			{
				name: "Goal completed",
				render: () => (
					<RowHost>
						<CustomRow entry={goalCompletedEntry} />
					</RowHost>
				),
			},
			{
				name: "Session exit",
				render: () => (
					<RowHost>
						<CustomRow entry={sessionExitEntry} />
					</RowHost>
				),
			},
		],
	}),
	defineStory({
		id: "tx-transcript-rows-session-exit-row",
		title: "SessionExitRow",
		component: {
			file: "apps/web/tx/components/transcript/rows/system.tsx",
			export: "SessionExitRow",
		},
		variants: [
			{
				name: "Clean exit with metadata",
				render: () => (
					<RowHost>
						<SessionExitRow entry={sessionExitEntry} data={exitData} />
					</RowHost>
				),
			},
			{
				name: "No payload",
				render: () => (
					<RowHost>
						<SessionExitRow entry={sessionExitEntry} data={null} />
					</RowHost>
				),
			},
		],
	}),
	defineStory({
		id: "tx-transcript-rows-goal-completed-row",
		title: "GoalCompletedRow",
		component: {
			file: "apps/web/tx/components/transcript/rows/system.tsx",
			export: "GoalCompletedRow",
		},
		variants: [
			{
				name: "Goal with usage",
				render: () => (
					<RowHost>
						<GoalCompletedRow entry={goalCompletedEntry} data={goalData} />
					</RowHost>
				),
			},
			{
				name: "No payload",
				render: () => (
					<RowHost>
						<GoalCompletedRow entry={goalCompletedEntry} data={null} />
					</RowHost>
				),
			},
		],
	}),

	// ---- entry-row.tsx dispatch ----
	defineStory({
		id: "tx-transcript-rows-entry-row",
		title: "TranscriptEntryRow",
		component: {
			file: "apps/web/tx/components/transcript/rows/entry-row.tsx",
			export: "TranscriptEntryRow",
		},
		variants: [
			{
				name: "Session header",
				render: () => (
					<RowHost>
						<TranscriptEntryRow entry={sessionHeaderEntry} pairing={emptyPairing} />
					</RowHost>
				),
			},
			{
				name: "User prompt",
				render: () => (
					<RowHost>
						<TranscriptEntryRow entry={userEntry} pairing={transcriptPairing} />
					</RowHost>
				),
			},
			{
				name: "Assistant with tool calls",
				render: () => (
					<RowHost>
						<TranscriptEntryRow entry={assistantRichEntry} pairing={transcriptPairing} />
					</RowHost>
				),
			},
			{
				name: "Standalone tool result",
				render: () => (
					<RowHost>
						<TranscriptEntryRow entry={toolResultEntry} pairing={emptyPairing} />
					</RowHost>
				),
			},
			{
				name: "File mention",
				render: () => (
					<RowHost>
						<TranscriptEntryRow entry={fileMentionEntry} pairing={emptyPairing} />
					</RowHost>
				),
			},
			{
				name: "Model change",
				render: () => (
					<RowHost>
						<TranscriptEntryRow entry={modelChangeEntry} pairing={emptyPairing} />
					</RowHost>
				),
			},
			{
				name: "Unknown entry type",
				render: () => (
					<RowHost>
						<TranscriptEntryRow entry={unknownTypeEntry} pairing={emptyPairing} />
					</RowHost>
				),
			},
		],
	}),
];
