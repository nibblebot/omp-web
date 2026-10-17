import type { JSX } from "solid-js";
import { TranscriptOverview } from "../../../web/tx/components/TranscriptOverview";
import { StoredSessionList } from "../../../web/tx/components/StoredSessionList";
import { TranscriptSubagents } from "../../../web/tx/components/TranscriptSubagents";
import { TranscriptList } from "../../../web/tx/components/TranscriptList";
import { TranscriptView } from "../../../web/tx/components/transcript";
import {
	transcriptPairing,
	healthErrorDb,
	healthMissingDb,
	health,
	sessionStats,
	quietSessionStats,
	unsyncedSessionStats,
	SESSION_FILE_BROKEN,
	SESSION_FILE_MAIN,
	SESSION_FILE_SECOND,
	SUBAGENT_FILE_ADVISOR,
	SUBAGENT_FILE_SCOUT,
} from "../../fixtures/tx";
import { defineStory } from "../../registry";

/** Tool names seen in the main transcript, sorted, as the filter dropdown lists them. */
const transcriptTools = [
	...new Set([...transcriptPairing.calls.values()].map((c) => c.name)),
].sort();

/** Sidebar selection for {@link TxPane}. The showcase only displays it; the sidebar callbacks are no-ops. */
export interface TxPaneProps {
	selectedFile?: string | null;
	selectedStored?: { workspaceId: string; sessionId: string } | null;
	children: JSX.Element;
}

/**
 * Production pane layout: a `.tx-app` grid with the transcript sidebar and a
 * `.tx-main` scroller. Virtualized transcript rows scroll the nearest
 * `.tx-main`, so a bare frame renders no rows.
 */
export function TxPane(props: TxPaneProps) {
	return (
		<div class="ds-frame ds-frame-tall">
			<div class="tx-app">
				<aside class="tx-sidebar open">
					<TranscriptList
						selectedFile={props.selectedFile ?? null}
						onOpen={() => {}}
						onOpenStored={() => {}}
						health={() => health}
						syncTick={() => 0}
						onSynced={() => {}}
					/>
					<StoredSessionList
						selectedWorkspaceId={props.selectedStored?.workspaceId ?? null}
						selectedSessionId={props.selectedStored?.sessionId ?? null}
						onOpenSession={() => {}}
						syncTick={() => 0}
					/>
				</aside>
				<main class="tx-main">{props.children}</main>
			</div>
		</div>
	);
}

export default [
	defineStory({
		id: "tx-transcript-overview",
		title: "TranscriptOverview",
		component: {
			file: "apps/web/tx/components/TranscriptOverview.tsx",
			export: "TranscriptOverview",
		},
		variants: [
			{
				name: "Synced session",
				render: () => (
					<div class="ds-frame ds-frame-tall">
						<TranscriptOverview
							stats={() => sessionStats}
							error={() => undefined}
							onPickTool={() => {}}
						/>
					</div>
				),
			},
			{
				name: "Quiet session (no tool calls)",
				render: () => (
					<div class="ds-frame ds-frame-tall">
						<TranscriptOverview
							stats={() => quietSessionStats}
							error={() => undefined}
							onPickTool={() => {}}
						/>
					</div>
				),
			},
			{
				name: "Not in stats.db yet (live JSONL)",
				render: () => (
					<div class="ds-frame ds-frame-tall">
						<TranscriptOverview
							stats={() => unsyncedSessionStats}
							error={() => undefined}
							onPickTool={() => {}}
						/>
					</div>
				),
			},
			{
				name: "Stats unavailable",
				render: () => (
					<div class="ds-frame ds-frame-tall">
						<TranscriptOverview
							stats={() => undefined}
							error={() => new Error("stats.db is locked by another process")}
							onPickTool={() => {}}
						/>
					</div>
				),
			},
		],
	}),
	defineStory({
		id: "tx-transcript-subagents",
		title: "TranscriptSubagents",
		component: {
			file: "apps/web/tx/components/TranscriptSubagents.tsx",
			export: "TranscriptSubagents",
		},
		variants: [
			{
				name: "Session with subagents",
				render: () => (
					<div class="ds-frame ds-frame-tall">
						<TranscriptSubagents file={SESSION_FILE_MAIN} onOpen={() => {}} />
					</div>
				),
			},
			{
				name: "Session without subagents",
				render: () => (
					<div class="ds-frame ds-frame-tall">
						<TranscriptSubagents file={SESSION_FILE_SECOND} onOpen={() => {}} />
					</div>
				),
			},
			{
				name: "Unreadable session",
				render: () => (
					<div class="ds-frame ds-frame-tall">
						<TranscriptSubagents file={SESSION_FILE_BROKEN} onOpen={() => {}} />
					</div>
				),
			},
		],
	}),
	defineStory({
		id: "tx-transcript-view",
		title: "TranscriptView",
		component: { file: "apps/web/tx/components/transcript/index.tsx", export: "TranscriptView" },
		variants: [
			{
				name: "Main session",
				render: () => (
					<TxPane selectedFile={SESSION_FILE_MAIN}>
						<TranscriptView
							file={SESSION_FILE_MAIN}
							isSub={false}
							onBackToMain={() => {}}
							tools={() => transcriptTools}
							toolFilter={null}
							onToolFilter={() => {}}
						/>
					</TxPane>
				),
			},
			{
				name: "Filtered to bash calls",
				render: () => (
					<TxPane selectedFile={SESSION_FILE_MAIN}>
						<TranscriptView
							file={SESSION_FILE_MAIN}
							isSub={false}
							onBackToMain={() => {}}
							tools={() => transcriptTools}
							toolFilter="bash"
							onToolFilter={() => {}}
						/>
					</TxPane>
				),
			},
			{
				name: "Subagent transcript",
				render: () => (
					<TxPane>
						<TranscriptView
							file={SUBAGENT_FILE_SCOUT}
							isSub={true}
							onBackToMain={() => {}}
							tools={() => transcriptTools}
							toolFilter={null}
							onToolFilter={() => {}}
						/>
					</TxPane>
				),
			},
			{
				name: "Advisor transcript",
				render: () => (
					<TxPane>
						<TranscriptView
							file={SUBAGENT_FILE_ADVISOR}
							isSub={true}
							onBackToMain={() => {}}
							tools={() => transcriptTools}
							toolFilter={null}
							onToolFilter={() => {}}
						/>
					</TxPane>
				),
			},
			{
				name: "Unreadable file",
				render: () => (
					<TxPane>
						<TranscriptView
							file={SESSION_FILE_BROKEN}
							isSub={false}
							onBackToMain={() => {}}
							tools={() => transcriptTools}
							toolFilter={null}
							onToolFilter={() => {}}
						/>
					</TxPane>
				),
			},
		],
	}),
	defineStory({
		id: "tx-transcript-list",
		title: "TranscriptList",
		component: { file: "apps/web/tx/components/TranscriptList.tsx", export: "TranscriptList" },
		variants: [
			{
				name: "Session list",
				render: () => (
					<div class="ds-frame ds-frame-tall">
						<TranscriptList
							selectedFile={null}
							onOpen={() => {}}
							onOpenStored={() => {}}
							health={() => health}
							syncTick={() => 0}
							onSynced={() => {}}
						/>
					</div>
				),
			},
			{
				name: "Session selected",
				render: () => (
					<div class="ds-frame ds-frame-tall">
						<TranscriptList
							selectedFile={SESSION_FILE_MAIN}
							onOpen={() => {}}
							onOpenStored={() => {}}
							health={() => health}
							syncTick={() => 0}
							onSynced={() => {}}
						/>
					</div>
				),
			},
			{
				name: "Stats DB missing (warning banner)",
				render: () => (
					<div class="ds-frame ds-frame-tall">
						<TranscriptList
							selectedFile={null}
							onOpen={() => {}}
							onOpenStored={() => {}}
							health={() => healthMissingDb}
							syncTick={() => 0}
							onSynced={() => {}}
						/>
					</div>
				),
			},
			{
				name: "Stats DB unreadable (error banner)",
				render: () => (
					<div class="ds-frame ds-frame-tall">
						<TranscriptList
							selectedFile={null}
							onOpen={() => {}}
							onOpenStored={() => {}}
							health={() => healthErrorDb}
							syncTick={() => 0}
							onSynced={() => {}}
						/>
					</div>
				),
			},
		],
	}),
	defineStory({
		id: "tx-stored-session-list",
		title: "StoredSessionList",
		component: {
			file: "apps/web/tx/components/StoredSessionList.tsx",
			export: "StoredSessionList",
		},
		variants: [
			{
				name: "Nothing selected",
				render: () => (
					<div class="ds-frame ds-frame-tall">
						<StoredSessionList
							selectedWorkspaceId={null}
							selectedSessionId={null}
							onOpenSession={() => {}}
							syncTick={() => 0}
						/>
					</div>
				),
			},
			{
				name: "Live worktree session selected",
				render: () => (
					<div class="ds-frame ds-frame-tall">
						<StoredSessionList
							selectedWorkspaceId="ws-omp-web"
							selectedSessionId="a1b2c3d4"
							onOpenSession={() => {}}
							syncTick={() => 0}
						/>
					</div>
				),
			},
			{
				name: "Orphaned workspace selected",
				render: () => (
					<div class="ds-frame ds-frame-tall">
						<StoredSessionList
							selectedWorkspaceId="ws-orphaned"
							selectedSessionId="0a1b2c3d"
							onOpenSession={() => {}}
							syncTick={() => 0}
						/>
					</div>
				),
			},
		],
	}),
];
