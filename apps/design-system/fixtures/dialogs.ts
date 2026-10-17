import type { BrowserUiContribution } from "#lib/wire/browser-ui-contract";
import type { BrowserUiRequest } from "../../web/store/browser-ui";
import type { BtwRecordView, BtwTranscriptTurnView } from "../../web/store/btw-history";
import {
	createCompactionState,
	type CompactionSnapshot,
	type CompactionState,
} from "../../web/store/compaction";
import type { GraphNode, GraphPage } from "../../web/store/graph";
import type { WebSessionState } from "#lib/wire/protocol";
import type { DebugEntry, state } from "../../web/state";
import type { FleetDebug } from "../../web/fleet-ui/fleet-debug";
import type { AskOption, AskQuestion, UiRequest } from "../../web/prompt/ask-types";
import { FIXTURE_NOW } from "./session";

const MIN = 60_000;
const at = (minutesAgo: number): number => FIXTURE_NOW - minutesAgo * MIN;
const iso = (minutesAgo: number): string => new Date(at(minutesAgo)).toISOString();

// ---------------------------------------------------------------------------
// Agent ask (ask tool): the AskBar docked above the prompt, and its fallback methods.
// ---------------------------------------------------------------------------

const scopeOptions: AskOption[] = [
	{ label: "Requests folder only", description: "apps/web/components/requests, 6 components" },
	{
		label: "Overlays and shared Modal",
		description: "Also touches shared/Modal.tsx and its callers",
	},
	{ label: "Whole web app", description: "Updates every import path; the slowest option" },
];

const checkOptions: AskOption[] = [
	{ label: "bun run check:types", description: "TypeScript across every workspace" },
	{ label: "bun run lint", description: "Biome lint and formatting" },
	{ label: "bun test apps/web", description: "Client unit tests" },
];

export const askScopeQuestion: AskQuestion = {
	id: "scope",
	header: "Scope",
	question: "Which files should the overlay story refactor cover?",
	options: scopeOptions,
	recommended: 0,
};

export const askChecksQuestion: AskQuestion = {
	id: "checks",
	header: "Checks",
	question: "Which checks should run before the commit?",
	options: checkOptions,
	multi: true,
};

/** Long content: option previews, a long question, and a multi-select with many rows. */
export const askLongQuestions: AskQuestion[] = [
	{
		id: "migration",
		header: "Migration plan",
		question:
			"The Modal portal moves into shared/Modal.tsx and the old per-dialog backdrop code goes away. How should existing callers that still pass a custom class name be handled while the migration lands?",
		options: [
			{
				label: "Keep the class name prop",
				description: "Callers keep working; the prop is removed in a follow-up.",
				preview: '<Modal title="Goal" class="goal-dialog" onClose={close}>',
			},
			{
				label: "Rewrite callers in this change",
				description: "One sweep, no shims; the diff touches 14 files.",
				preview: '<Modal title="Goal" variant="sheet" onClose={close}>',
			},
		],
		recommended: 1,
	},
	{
		id: "files",
		header: "Files",
		question: "Which story groups should be regenerated?",
		options: [
			{ label: "requests-ask-bar" },
			{ label: "sessions-session-tree-panel" },
			{ label: "requests-extension-ui" },
			{ label: "requests-btw-sheet" },
			{ label: "chat-controls-compaction-dialog" },
			{ label: "app-fleet-debug-sheet" },
			{ label: "requests-download-dialog" },
			{ label: "chat-controls-goal-dialog" },
			{ label: "chat-composer-prompt-history-picker" },
			{ label: "models-provider-login-dialog" },
		],
		multi: true,
	},
];

/** Ask tool request, as the daemon pushes it: method "askDialog" carries the question list. */
export function askDialogRequest(id: string, questions: AskQuestion[]): UiRequest {
	return { id, method: "askDialog", params: { questions } };
}

export const confirmParams = {
	title: "Discard the unsaved plan draft?",
	message:
		"plan-mode.md has three edits that were never saved. Discarding restores the last saved version and cannot be undone.",
};

export const selectParams = {
	title: "Reviewer model",
	options: [
		"claude-sonnet-4.5",
		"claude-opus-4.1",
		{
			label: "gpt-5-codex",
			description: "OpenAI, slower but stricter on diffs",
		} satisfies AskOption,
		"gemini-2.5-pro",
	],
};

export const inputParams = {
	title: "Branch name for the stories split",
	placeholder: "feature/overlay-stories",
};

export const editorParams = {
	title: "Edit the handoff note",
	prefill:
		"Overlay stories: GoalDialog and BtwSheet are covered.\nRemaining: DownloadDialog consent phase, ProviderLoginDialog providers.\n",
};

// ---------------------------------------------------------------------------
// Danger confirm (prompt/danger-confirm): module-level request, opened by callers.
// ---------------------------------------------------------------------------

export interface DangerSample {
	title: string;
	body: string;
	confirmLabel: string;
}

export const dangerSamples: DangerSample[] = [
	{
		title: "Reset provider state?",
		body: "Clears saved OAuth tokens and cached model lists for every provider. You will need to sign in again before the next prompt.",
		confirmLabel: "Reset",
	},
	{
		title: "Trust MCP server?",
		body: "The linear server runs as a local process with access to your workspace and environment variables. Only trust servers you installed yourself.",
		confirmLabel: "Trust server",
	},
	{
		title: "Trust plugin code?",
		body: "omp-review-kit runs its hooks inside the agent process. Trusting it lets those hooks read and write files in this repository.",
		confirmLabel: "Trust plugin",
	},
];

// ---------------------------------------------------------------------------
// /btw side panel: store `btw` slice.
// ---------------------------------------------------------------------------

type AppState = typeof state;
export type BtwSheetState = NonNullable<AppState["btw"]>;

export const btwStreaming: BtwSheetState = {
	question: "Why does the tool card collapse when the window narrows?",
	reply: "The collapse comes from the tool header row. Below 520px the",
	streaming: true,
	streamId: 7,
};

export const btwAnswered: BtwSheetState = {
	question: "Does the approval queue survive a reconnect?",
	reply:
		"Yes. Pending approvals live in the daemon roster, not the browser. On reconnect the client re-reads the queue from the `state` frame, so a card that was open before the drop is still listed.\n\nThe only gap is the 2 s window between the socket closing and the first state frame; the card shows a stale marker during it.",
	streaming: false,
	streamId: 8,
};

export const btwFailed: BtwSheetState = {
	question: "Summarize the open review annotations",
	reply: "",
	streaming: false,
	streamId: 9,
	error: "Provider returned 429: rate limit reached. Retry in 20 s.",
};

// ---------------------------------------------------------------------------
// /btw history: daemon answers for btwList and btwPage.
// ---------------------------------------------------------------------------

export const btwHistoryRecords: BtwRecordView[] = [
	{
		id: "btw_41",
		leafId: "leaf_118",
		question: "What does the Run key point at?",
		answer: "The id of the first tool item in the run, so it stays stable as later tools append.",
		status: "complete",
		createdAt: at(42),
		updatedAt: at(41),
	},
	{
		id: "btw_42",
		leafId: "leaf_122",
		question: "Can the review panel run offline?",
		answer: "Only the cached annotations. New comments need the daemon to be reachable.",
		status: "complete",
		createdAt: at(18),
		updatedAt: at(17),
		followUps: [
			{
				question: "And the queued posts?",
				answer: "They wait in localStorage and send once the connection returns.",
				status: "complete",
				createdAt: at(16),
				updatedAt: at(16),
			},
		],
	},
	{
		id: "btw_43",
		leafId: null,
		question: "Summarize the compaction handoff anchor",
		answer: "",
		status: "running",
		createdAt: at(2),
		updatedAt: at(2),
	},
	{
		id: "btw_44",
		leafId: null,
		question: "Which branch holds the tier-0 stories?",
		answer: "",
		status: "interrupted",
		createdAt: at(9),
		updatedAt: at(8),
		error: "connection lost mid-answer",
	},
];

/** Transcript turns for one record (btwPage answer). */
export function btwTranscriptFor(recordId: string): BtwTranscriptTurnView[] {
	if (recordId !== "btw_41") return [];
	return [
		{
			key: "btw_41:0",
			index: 0,
			question: "What does the Run key point at?",
			answer: "The id of the first tool item in the run, so it stays stable as later tools append.",
			status: "complete",
			createdAt: at(42),
			updatedAt: at(41),
		},
		{
			key: "btw_41:1",
			index: 1,
			question: "Does the id change when a tool retries?",
			answer: "No. A retry reuses the item id and appends a retry badge.",
			status: "complete",
			createdAt: at(40),
			updatedAt: at(40),
		},
	];
}

// ---------------------------------------------------------------------------
// Session tree (SessionTreePanel): daemon answer for getSessionGraph.
// ---------------------------------------------------------------------------

function node(
	id: string,
	parentId: string | null,
	type: GraphNode["type"],
	preview: string,
	minutesAgo: number,
	childCount: number,
	label?: string,
): GraphNode {
	return {
		id,
		parentId,
		type,
		...(label ? { label } : {}),
		timestamp: iso(minutesAgo),
		preview,
		hasImages: false,
		childCount,
	};
}

const graphNodes: GraphNode[] = [
	node("n01", null, "user", "Split the overlay stories by tier", 96, 1),
	node("n02", "n01", "assistant", "Reading the component graph for the overlay group", 95, 2),
	node("n03", "n02", "tool", "apps/web/components/sessions/SessionTreePanel.tsx", 94, 0, "read"),
	node("n04", "n02", "tool", "apps/web/store/graph.ts", 93, 0, "read"),
	node(
		"n05",
		"n02",
		"assistant",
		"SessionTreePanel shows the tree when the capability is on",
		92,
		1,
	),
	node("n06", "n05", "user", "Keep the legacy header path in the story too", 90, 1),
	node("n07", "n06", "assistant", "Added a variant with graph.available set to false", 89, 1),
	node("n08", "n07", "compaction", "Compacted 31 turns into a handoff", 70, 1),
	node("n09", "n08", "summary", "Overlay group: 20 exports, 9 tier-0 leaves", 69, 1),
	node("n10", "n09", "user", "Fork the graph story from here", 12, 0),
];

export const sessionGraphPage: GraphPage = {
	sessionId: "sess_9d2c",
	revision: "rev_17",
	leafId: "n07",
	nodes: graphNodes,
	hasMore: false,
	nextCursor: null,
};

/** A longer page with a cursor: exercises the "more nodes" paging state. */
export const sessionGraphPageMore: GraphPage = {
	...sessionGraphPage,
	revision: "rev_18",
	nodes: graphNodes.slice(0, 6),
	hasMore: true,
	nextCursor: "cur_6",
};

// ---------------------------------------------------------------------------
// Compaction: daemon answer for compactionSnapshot, plus store slice builders.
// ---------------------------------------------------------------------------

const softOk = { eligible: true } as const;

export const compactionSnapshotReady: CompactionSnapshot = {
	eligibility: {
		soft: { eligible: true },
		remote: { eligible: true, interruptsTurn: false },
		snapcompact: { eligible: true, interruptsTurn: true },
	},
	context: { usedTokens: 142_000, contextWindow: 200_000 },
	autoCompactionEnabled: true,
	active: false,
	handoff: {
		sessionId: "sess_9d2c",
		leafId: "n07",
		historyMessages: 48,
		handoffActive: false,
		activeTurnPolicy: "snapshot-without-aborting-turn",
		eligible: true,
		keepRecentTokens: 20_000,
	},
	remotePolicy: "remote-then-soft",
};

export const compactionSnapshotRemoteBlocked: CompactionSnapshot = {
	...compactionSnapshotReady,
	eligibility: {
		soft: softOk,
		remote: {
			eligible: false,
			reason: "Remote compaction needs an Anthropic route; this session runs through OpenRouter.",
		},
		snapcompact: {
			eligible: false,
			reason: "Snapcompact is disabled for models without image input.",
		},
	},
	context: { usedTokens: 61_400, contextWindow: 200_000 },
	autoCompactionEnabled: false,
};

/** Store slice builder: the pristine compaction state with overrides applied. */
export function compactionWith(overrides: Partial<CompactionState>): CompactionState {
	return { ...createCompactionState(), ...overrides };
}

// ---------------------------------------------------------------------------
// Debug modal and clock: store debug log and frame timing.
// ---------------------------------------------------------------------------

export const debugLogEntries: DebugEntry[] = [
	{ ts: at(14), level: "info", source: "transport", message: "/events stream opened (seq 0)" },
	{ ts: at(13), level: "info", source: "roster", message: "daemon d_7f3a registered (omp-web)" },
	{ ts: at(9), level: "info", source: "command", message: "prompt accepted (sess_9d2c)" },
	{ ts: at(6), level: "warn", source: "transport", message: "frame gap: seq 412 to 415" },
	{
		ts: at(4),
		level: "error",
		source: "command",
		message: "getSessionGraph failed: revision mismatch",
	},
	{ ts: at(1), level: "info", source: "transport", message: "resumed after 2 s without frames" },
];

export const debugLogReconnecting: DebugEntry[] = [
	{ ts: at(1), level: "warn", source: "transport", message: "stream closed (network reset)" },
	{
		ts: at(1),
		level: "info",
		source: "transport",
		message: "reconnect attempt 2 scheduled in 4 s",
	},
];

/** Fleet log rows for DebugLog (FleetDebug["log"] entries). */
export const fleetLogEntries: FleetDebug["log"] = [
	{ ts: at(30), level: "info", source: "fleet", message: "control plane listening on :4800" },
	{
		ts: at(22),
		level: "info",
		source: "roster",
		message: "daemon d_7f3a attached",
		daemonId: "d_7f3a",
	},
	{
		ts: at(20),
		level: "info",
		source: "roster",
		message: "daemon d_b201 attached",
		daemonId: "d_b201",
	},
	{
		ts: at(11),
		level: "warn",
		source: "roster",
		message: "daemon d_b201 missed a heartbeat",
		daemonId: "d_b201",
	},
	{
		ts: at(10),
		level: "info",
		source: "roster",
		message: "daemon d_b201 heartbeat restored",
		daemonId: "d_b201",
	},
	{
		ts: at(3),
		level: "error",
		source: "roster",
		message: "daemon d_c4e9 refused attach: wrong token",
		daemonId: "d_c4e9",
	},
];

// ---------------------------------------------------------------------------
// Prompt history (PromptHistoryPicker): localStorage "omp-web:history", oldest first.
// ---------------------------------------------------------------------------

export const promptHistoryEntries: string[] = [
	"Read the overlay components and list their props",
	"Split the stories by tier and keep fixtures typed",
	"Why does SessionTreePanel show the unavailable header?",
	"Add a variant for the remote compaction refusal",
	"Run the type check once the overlay stories land",
	"Explain the call relay used by the design server",
];

export const promptHistoryLong: string[] = [
	"Refactor the download flow so the consent body reads the manifest directly",
	"Multi-line prompt:\nfirst, list every caller of openDownloadConsent\nthen, wire the archive kind to the worker count\nfinally, keep the legacy HTML path unchanged",
];

// ---------------------------------------------------------------------------
// Login modal: provider list, browser URL, and manual code prompt.
// ---------------------------------------------------------------------------

export interface LoginProviderRow {
	id: string;
	name: string;
	available: boolean;
	authenticated: boolean;
}

export const loginProviders: LoginProviderRow[] = [
	{ id: "anthropic", name: "Anthropic", available: true, authenticated: true },
	{ id: "openai-codex", name: "OpenAI Codex", available: true, authenticated: false },
	{ id: "github-copilot", name: "GitHub Copilot", available: true, authenticated: false },
	{ id: "google-gemini-cli", name: "Google Gemini CLI", available: false, authenticated: false },
];

export const loginBrowserUrl: NonNullable<AppState["loginUrl"]> = {
	url: "https://auth.openai.com/oauth/authorize?client_id=omp&state=4f1c",
	instructions:
		"Finish sign-in in the browser tab that just opened. This page updates when it completes.",
};

export const loginCodePrompt: NonNullable<AppState["loginCodeRequest"]> = {
	requestId: "login_3",
	title: "Paste the device code from GitHub",
	placeholder: "XXXX-XXXX",
};

// ---------------------------------------------------------------------------
// Goal modal: store goalModeState variants.
// ---------------------------------------------------------------------------

type GoalModeState = NonNullable<WebSessionState["goalModeState"]>;
export type GoalRecord = GoalModeState["goal"];

export const goalActive: GoalRecord = {
	id: "goal_01",
	objective: "Ship the overlay stories for the design-system showcase",
	status: "active",
	tokenBudget: 400_000,
	tokensUsed: 184_300,
	timeUsedSeconds: 2_730,
	createdAt: at(120),
	updatedAt: at(1),
};

export const goalPaused: GoalRecord = {
	...goalActive,
	id: "goal_02",
	objective: "Migrate the roster filters to the shared picker",
	status: "paused",
	tokensUsed: 51_900,
	timeUsedSeconds: 640,
	createdAt: at(300),
	updatedAt: at(180),
};

export const goalBudgetLimited: GoalRecord = {
	...goalActive,
	id: "goal_03",
	objective: "Trim the bundle below 600 kB without dropping the review panel",
	status: "budget-limited",
	tokenBudget: 150_000,
	tokensUsed: 150_000,
	timeUsedSeconds: 4_410,
	createdAt: at(400),
	updatedAt: at(20),
};

export const goalCompleted: GoalRecord = {
	...goalActive,
	id: "goal_04",
	objective: "Document the download consent flow in the changelog",
	status: "complete",
	tokenBudget: 90_000,
	tokensUsed: 71_200,
	timeUsedSeconds: 1_180,
	createdAt: at(200),
	updatedAt: at(5),
};

// ---------------------------------------------------------------------------
// Browser UI: a widget contribution placed below the editor.
// ---------------------------------------------------------------------------

export const belowEditorWidget: BrowserUiContribution = {
	id: "checks.summary",
	kind: "widget",
	owner: "github-checks",
	title: "PR checks",
	payload: {
		blocks: [
			{
				type: "text",
				text: "**3** checks passed, **1** running, **1** failing on `feature/overlay-stories`.",
				markdown: true,
			},
			{
				type: "list",
				items: [
					"types: passed",
					"lint: passed",
					"web tests: running",
					"e2e: failing (login.spec.ts)",
				],
			},
			{
				type: "actions",
				actions: [
					{ id: "rerun", label: "Re-run failed" },
					{ id: "open", label: "Open PR" },
				],
			},
		],
		placement: "belowEditor",
	},
	version: 1,
};

export const belowEditorRequest: BrowserUiRequest = {
	requestId: "bui_3",
	contribution: belowEditorWidget,
	scope: undefined,
	busy: false,
	error: null,
};
