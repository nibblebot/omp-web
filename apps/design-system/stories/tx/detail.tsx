import { StoredSessionPage } from "../../../web/tx/components/StoredSessionPage";
import {
	ResumeCloneDialog,
	openResumeClone,
	openResumeCloneSession,
} from "../../../web/tx/components/ResumeCloneDialog";
import { StoredTranscriptPane } from "../../../web/tx/components/StoredTranscriptView";
import { TranscriptDetail } from "../../../web/tx/components/TranscriptDetail";
import type { StoredFileInfo, StoredSessionDetail } from "#lib/wire/stats-types";
import {
	SESSION_FILE_BROKEN,
	SESSION_FILE_MAIN,
	SESSION_FILE_UNSYNCED,
	storedSessionDetail,
	storedWorkspaces,
} from "../../fixtures/tx";
import { TxPane } from "./views";
import { defineStory } from "../../registry";

/** Stored session detail the stories render; throws if the fixture is missing. */
function detailFor(workspaceId: string, sessionId: string): StoredSessionDetail {
	const detail = storedSessionDetail(workspaceId, sessionId);
	if (!detail) throw new Error(`no stored session ${workspaceId}/${sessionId}`);
	return detail;
}

/** Stored file of one kind in a session detail; throws if the fixture lacks it. */
function fileOf(detail: StoredSessionDetail, kind: StoredFileInfo["kind"]): StoredFileInfo {
	const file = detail.files.find((f) => f.kind === kind);
	if (!file) throw new Error(`session ${detail.sessionId} has no ${kind} file`);
	return file;
}

/** Stored workspace row for the resume dialog; throws if the fixture lacks it. */
function workspace(id: string): (typeof storedWorkspaces)[number] {
	const found = storedWorkspaces.find((w) => w.workspaceId === id);
	if (!found) throw new Error(`no stored workspace ${id}`);
	return found;
}

const liveMain = detailFor("ws-omp-web", "a1b2c3d4");
const retryDetail = detailFor("ws-omp-web", "e5f6a7b8");

export default [
	defineStory({
		id: "tx-transcript-detail",
		title: "TranscriptDetail",
		component: { file: "apps/web/tx/components/TranscriptDetail.tsx", export: "TranscriptDetail" },
		variants: [
			{
				name: "Synced session",
				render: () => (
					<TxPane selectedFile={SESSION_FILE_MAIN}>
						<TranscriptDetail file={SESSION_FILE_MAIN} syncTick={() => 0} onSynced={() => {}} />
					</TxPane>
				),
			},
			{
				name: "Not in stats.db yet",
				render: () => (
					<TxPane selectedFile={SESSION_FILE_UNSYNCED}>
						<TranscriptDetail file={SESSION_FILE_UNSYNCED} syncTick={() => 0} onSynced={() => {}} />
					</TxPane>
				),
			},
			{
				name: "Unreadable session",
				render: () => (
					<TxPane selectedFile={SESSION_FILE_BROKEN}>
						<TranscriptDetail file={SESSION_FILE_BROKEN} syncTick={() => 0} onSynced={() => {}} />
					</TxPane>
				),
			},
		],
	}),
	defineStory({
		id: "tx-stored-session-page",
		title: "StoredSessionPage",
		component: {
			file: "apps/web/tx/components/StoredSessionPage.tsx",
			export: "StoredSessionPage",
		},
		variants: [
			{
				name: "Live worktree session",
				render: () => (
					<div class="ds-frame ds-frame-tall">
						<StoredSessionPage workspaceId="ws-omp-web" sessionId="a1b2c3d4" />
					</div>
				),
			},
			{
				name: "Subagent artifact missing",
				render: () => (
					<div class="ds-frame ds-frame-tall">
						<StoredSessionPage workspaceId="ws-omp-web" sessionId="e5f6a7b8" />
					</div>
				),
			},
			{
				name: "Orphaned clone (read-only)",
				render: () => (
					<div class="ds-frame ds-frame-tall">
						<StoredSessionPage workspaceId="ws-orphaned" sessionId="0a1b2c3d" />
					</div>
				),
			},
			{
				name: "Benchmark clone, no subagents",
				render: () => (
					<div class="ds-frame ds-frame-tall">
						<StoredSessionPage workspaceId="ws-bench-old" sessionId="7c8d9e0f" />
					</div>
				),
			},
		],
	}),
	defineStory({
		id: "tx-stored-transcript-pane",
		title: "StoredTranscriptPane",
		component: {
			file: "apps/web/tx/components/StoredTranscriptView.tsx",
			export: "StoredTranscriptPane",
		},
		variants: [
			{
				name: "Main transcript",
				render: () => (
					<TxPane selectedStored={{ workspaceId: "ws-omp-web", sessionId: "a1b2c3d4" }}>
						<StoredTranscriptPane
							workspaceId="ws-omp-web"
							sessionId="a1b2c3d4"
							relpath={fileOf(liveMain, "main").relpath}
						/>
					</TxPane>
				),
			},
			{
				name: "Subagent artifact",
				render: () => (
					<TxPane selectedStored={{ workspaceId: "ws-omp-web", sessionId: "a1b2c3d4" }}>
						<StoredTranscriptPane
							workspaceId="ws-omp-web"
							sessionId="a1b2c3d4"
							relpath={fileOf(liveMain, "subagent").relpath}
						/>
					</TxPane>
				),
			},
			{
				name: "Advisor transcript",
				render: () => (
					<TxPane selectedStored={{ workspaceId: "ws-omp-web", sessionId: "a1b2c3d4" }}>
						<StoredTranscriptPane
							workspaceId="ws-omp-web"
							sessionId="a1b2c3d4"
							relpath={fileOf(liveMain, "advisor").relpath}
						/>
					</TxPane>
				),
			},
			{
				name: "Missing subagent artifact",
				render: () => (
					<TxPane selectedStored={{ workspaceId: "ws-omp-web", sessionId: "e5f6a7b8" }}>
						<StoredTranscriptPane
							workspaceId="ws-omp-web"
							sessionId="e5f6a7b8"
							relpath={fileOf(retryDetail, "subagent").relpath}
						/>
					</TxPane>
				),
			},
		],
	}),
	defineStory({
		id: "tx-resume-clone-dialog",
		title: "ResumeCloneDialog",
		component: {
			file: "apps/web/tx/components/ResumeCloneDialog.tsx",
			export: "ResumeCloneDialog",
		},
		tabs: true,
		seed: {
			providerProfiles: [
				{ id: "github-readonly", provider: "bwrap", network: "isolated" },
				{ id: "fleet-k8s", provider: "kubernetes", storageClassName: "fast-ssd" },
			],
		},
		variants: [
			{
				name: "Orphaned clone, pick a session",
				seed: () => openResumeClone(workspace("ws-orphaned")),
				render: () => <ResumeCloneDialog />,
			},
			{
				name: "Session preselected from detail",
				seed: () => openResumeCloneSession(workspace("ws-orphaned"), "0a1b2c3d"),
				render: () => <ResumeCloneDialog />,
			},
			{
				name: "Benchmark clone",
				seed: () => openResumeClone(workspace("ws-bench-old")),
				render: () => <ResumeCloneDialog />,
			},
		],
	}),
];
