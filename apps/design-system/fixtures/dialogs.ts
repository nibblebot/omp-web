import type { BrowserUiContribution } from "#lib/wire/browser-ui-contract";
import type { BrowserUiRequest } from "../../web/store/browser-ui";
import type { BtwRecordView, BtwTranscriptTurnView } from "../../web/store/btw-history";
import {
	createCompactionState,
	type CompactionSnapshot,
	type CompactionState,
} from "../../web/store/compaction";
import { answerCalls, type CallHandlers } from "../session";
import type { GraphNode, GraphPage } from "../../web/store/graph";
import type { UiApprovalParams, WebSessionState } from "#lib/wire/protocol";
import type { DebugEntry, state } from "../../web/state";
import type { FleetDebug } from "../../web/fleet-ui/fleet-debug";
import type { AskOption, AskQuestion, UiRequest } from "../../web/prompt/ask-types";
import type {
	UiFormBlock,
	UiFormChoiceField,
	UiFormField,
	UiFormOption,
	UiFormParams,
	UiFormSection,
	UiFormSpan,
	UiFormSpanStyle,
	UiFormTextField,
} from "#lib/wire/ask-form";
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

/** Three headed questions (one multi-select) so the step tabs show their labels. */
export const askTabbedQuestions: AskQuestion[] = [
	askScopeQuestion,
	askChecksQuestion,
	{
		id: "rollout",
		header: "Rollout",
		question: "How should the change ship?",
		options: [
			{ label: "Behind a flag", description: "Off by default until the next release" },
			{ label: "Straight to main", description: "Enabled for everyone on merge" },
		],
		recommended: 0,
	},
];

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

/** An extension's `ui.askDialog` request, as the session pushes it: method "askDialog" carries the question list. */
export function askDialogRequest(id: string, questions: AskQuestion[]): UiRequest {
	return { id, method: "askDialog", params: { questions } };
}

// The ask tool's HTML form (method "formDialog"): the session sends the parsed form with its
// pictures already resolved to data: URIs.

const span = (text: string, style?: UiFormSpanStyle): UiFormSpan =>
	style ? { text, style } : { text };
const plain = (text: string): UiFormSpan[] => [span(text)];

function formOption(
	value: string,
	label: string,
	state: Partial<Pick<UiFormOption, "checked" | "disabled">> = {},
): UiFormOption {
	return { value, label: plain(label), checked: false, disabled: false, ...state };
}

function choiceField(
	index: number,
	name: string,
	question: string,
	options: UiFormOption[],
	extra: Partial<UiFormChoiceField> = {},
): UiFormChoiceField {
	return {
		kind: "choice",
		index,
		question,
		name,
		label: [],
		required: false,
		multi: false,
		select: false,
		other: false,
		options,
		...extra,
	};
}

function textField(
	index: number,
	name: string,
	question: string,
	extra: Partial<UiFormTextField> = {},
): UiFormTextField {
	return {
		kind: "text",
		index,
		question,
		name,
		label: plain(question),
		required: false,
		type: "text",
		multiline: false,
		value: "",
		placeholder: "",
		rows: 1,
		...extra,
	};
}

const field = (f: UiFormField): UiFormBlock => ({ kind: "field", field: f });
const text = (spans: UiFormSpan[]): UiFormBlock => ({ kind: "text", spans, heading: false });

/** A small architecture sketch, as the session sends a picture: a data: URI. */
const sketchSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="90" viewBox="0 0 360 90">
<rect x="4" y="20" width="90" height="50" rx="6" fill="#313244" stroke="#89b4fa"/>
<text x="49" y="50" font-size="13" fill="#cdd6f4" text-anchor="middle" font-family="sans-serif">browser</text>
<rect x="135" y="20" width="90" height="50" rx="6" fill="#313244" stroke="#89b4fa"/>
<text x="180" y="50" font-size="13" fill="#cdd6f4" text-anchor="middle" font-family="sans-serif">session</text>
<rect x="266" y="20" width="90" height="50" rx="6" fill="#313244" stroke="#a6e3a1"/>
<text x="311" y="50" font-size="13" fill="#cdd6f4" text-anchor="middle" font-family="sans-serif">store</text>
<path d="M94 45H135M225 45H266" stroke="#a6adc8" stroke-width="2"/>
</svg>`;
const sketchSrc = `data:image/svg+xml;base64,${btoa(sketchSvg)}`;

/** A realistic agent form: context, a recommended radio, a checkbox group, a select, a number and a textarea. */
export const askFormParams: UiFormParams = {
	sections: [
		{
			title: [],
			blocks: [
				text([
					span("Sessions live in memory and are lost on restart. A store keeps them across "),
					span("omp-session", "code"),
					span(" restarts."),
				]),
				{ kind: "image", src: sketchSrc, alt: "browser, session and store in a row" },
				{
					kind: "table",
					headerRows: 1,
					rows: [
						[plain("Store"), plain("Ops cost"), plain("Shared")],
						[plain("SQLite"), plain("none"), plain("no")],
						[plain("Redis"), plain("a service"), plain("yes")],
					],
				},
			],
		},
		{
			title: plain("Session store"),
			blocks: [
				field(
					choiceField(
						0,
						"store",
						"Session store",
						[
							formOption("sqlite", "SQLite: one file, no new service", { checked: true }),
							formOption("redis", "Redis: shared across instances, needs ops"),
							formOption("postgres", "Postgres: already deployed", { disabled: true }),
						],
						{ required: true, other: true },
					),
				),
			],
		},
		{
			title: plain("Checks before the commit"),
			blocks: [
				text([span("Pick everything that should pass first.", "em")]),
				field(
					choiceField(
						1,
						"checks",
						"Checks before the commit",
						[
							formOption("types", "bun run check:types", { checked: true }),
							formOption("lint", "bun run lint"),
							formOption("test", "bun test apps/session"),
						],
						{ multi: true, other: true },
					),
				),
			],
		},
		{
			title: plain("Details"),
			blocks: [
				field(
					choiceField(
						2,
						"region",
						"Region",
						[
							formOption("eu", "Europe", { checked: true }),
							formOption("us", "United States"),
							formOption("ap", "Asia Pacific"),
						],
						{ select: true, label: plain("Region") },
					),
				),
				field(
					textField(3, "ttl_days", "Session lifetime (days)", {
						type: "number",
						value: "30",
						min: 1,
						max: 365,
						required: true,
					}),
				),
				field(
					textField(4, "notes", "Notes for the migration", {
						type: "textarea",
						multiline: true,
						rows: 3,
						placeholder: "Anything the agent should know",
					}),
				),
			],
		},
	],
	hidden: [["source", "ask-form-story"]],
};

/** A form with a countdown: the session submits its defaults at the deadline. */
export function askFormWithDeadline(deadline: number): UiFormParams {
	return { ...askFormParams, deadline };
}

/** Required and bounded fields left empty or out of range: Submit lists what to fix and focuses the first. */
export const askRequiredFormParams: UiFormParams = {
	sections: [
		{
			title: plain("Release"),
			blocks: [
				field(
					textField(0, "version", "Version", {
						required: true,
						placeholder: "1.4.0",
						pattern: "\\d+\\.\\d+\\.\\d+",
					}),
				),
				field(
					choiceField(
						1,
						"channels",
						"Channels to publish to",
						[
							formOption("stable", "stable"),
							formOption("beta", "beta"),
							formOption("nightly", "nightly"),
						],
						{ multi: true, required: true },
					),
				),
				field(
					textField(2, "rollout", "Rollout percent", {
						type: "number",
						value: "250",
						min: 1,
						max: 100,
					}),
				),
			],
		},
	],
	hidden: [],
};

/** Many sections and fields: the form body scrolls while the title and Submit stay in view. */
export const askLongFormParams: UiFormParams = (() => {
	const topics = [
		"Logging",
		"Metrics",
		"Tracing",
		"Alerting",
		"Backups",
		"Rate limits",
		"Feature flags",
		"Release channel",
	];
	const sections: UiFormSection[] = topics.map((topic, i) => ({
		title: plain(topic),
		blocks: [
			text([span(`How should ${topic.toLowerCase()} be handled for the new service?`)]),
			field(
				choiceField(
					i * 2,
					`topic_${i}`,
					topic,
					[
						formOption("default", "Keep the current setup", { checked: true }),
						formOption("minimal", "Minimal: the cheapest thing that works"),
						formOption("full", "Full: everything the platform offers"),
					],
					{ other: true },
				),
			),
			field(textField(i * 2 + 1, `topic_${i}_note`, `${topic} notes`, { placeholder: "Optional" })),
		],
	}));
	return { sections, hidden: [] };
})();

/** A form request, as the session pushes it: method "formDialog" carries the structured form. */
export function askFormRequest(id: string, params: UiFormParams): UiRequest {
	return { id, method: "formDialog", params };
}

export const confirmParams = {
	title: "Discard the unsaved plan draft?",
	message:
		"plan-mode.md has three edits that were never saved. Discarding restores the last saved version and cannot be undone.",
};

export const selectParams = {
	title: "Reviewer model",
	options: [
		"claude-sonnet-5.5",
		"claude-opus-5.5",
		{
			label: "gpt-5-codex",
			description: "OpenAI, slower but stricter on diffs",
		} satisfies AskOption,
		"gemini-2.5-pro",
	],
};

/** Tool approval with nothing to remember: approve, or deny (the SDK's `approve` ui_request). */
export const approvalParams: UiApprovalParams = {
	full: [
		"Allow tool: mcp__linear__create_issue",
		"Origin: MCP server tool",
		"Arguments:",
		"{",
		'  "team": "WEB",',
		'  "title": "Approval prompts lose their line breaks",',
		'  "description": "',
		"    Each argument sits on its own line in the prompt.",
		"    The approval bar must keep those line breaks and indentation.",
		'  "',
		"}",
	].join("\n"),
};

/** The same prompt plus the approve-for-this-session choice. */
export const approvalSessionParams: UiApprovalParams = {
	...approvalParams,
	session: "Approve mcp__linear__create_issue for this session",
};

/** An always-ask-cached prompt: session choice plus a directory grant and an exact-file grant. */
export const approvalGrantsParams: UiApprovalParams = {
	full: [
		"Allow tool: write",
		"Path: apps/web/components/requests/AskBar.tsx",
		"Directory: apps/web/components/requests",
		"  AskBar.tsx",
		"  BtwSheet.tsx",
		"  DangerConfirmDialog.tsx",
		"  DownloadDialog.tsx",
		"  ExtensionUi.tsx",
	].join("\n"),
	session: "Approve write for this session",
	grants: [
		{
			scope: "folder",
			label: "Approve Directory: apps/web/components/requests",
			alwaysLabel: "Always Approve Directory: apps/web/components/requests",
		},
		{ scope: "target", label: "Approve File", alwaysLabel: "Always Approve File" },
	],
};

export const inputParams = {
	title: "Branch name for the stories split",
	placeholder: "feature/overlay-stories",
};

/** An `input` request with the SDK's `secret` option: the field is masked. */
export const secretInputParams = {
	title: "API token for the staging registry",
	placeholder: "paste the token",
	secret: true,
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
		"Yes. Pending approvals live in the session process roster, not the browser. On reconnect the client re-reads the queue from the `state` frame, so a card that was open before the drop is still listed.\n\nThe only gap is the 2 s window between the socket closing and the first state frame; the card shows a stale marker during it.",
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

/** A steering prompt mid-draft (`btw.inject` on): the unclosed block already shows behind its rail. */
export const btwInjectStreaming: BtwSheetState = {
	question: "Write a prompt that tells the agent to stop adding retries",
	reply:
		"Here is a message you can send:\n\n<inject>Stop adding retry loops around the transport calls. Surface the failure to the caller and let the existing backoff",
	streaming: true,
	streamId: 10,
};

// ---------------------------------------------------------------------------
// /btw history: session answers for btwList and btwPage.
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
		answer: "Only the cached annotations. New comments need the session process to be reachable.",
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
	{
		id: "btw_45",
		leafId: "leaf_131",
		question: "Draft a steering prompt that gets the agent to fix the build first",
		answer:
			"Here is a message you can send to the main session:\n\n<inject>Pause the refactor and fix the failing build first, then rerun the tests before continuing.</inject>\n\nIt keeps the refactor intact and unblocks CI before any more files change.",
		status: "complete",
		createdAt: at(5),
		updatedAt: at(4),
		inject: "pending",
	},
	{
		id: "btw_46",
		leafId: "leaf_127",
		question: "Write the instruction that tells the agent to stop touching the lockfile",
		answer:
			"<inject>Stop editing bun.lock by hand. Regenerate it with bun install, and commit it only when package.json changed.</inject>",
		status: "complete",
		createdAt: at(26),
		updatedAt: at(25),
		inject: "sent",
	},
];

/** Records whose steering prompt a story or the demo sent through `btwInject` (reset by each seed). */
const injectedIds = new Set<string>();

/** Side questions asked through `btwStart` (and follow-ups added to them) since the last seed, newest first. */
let askedRecords: BtwRecordView[] = [];
let nextAskedId = 1;

const BTW_CANNED_ANSWER =
	"The session answers side questions on its own model without touching the main transcript; promote one when it belongs there.";

/** The saved records as the session reports them now: a sent prompt reads as sent. */
function currentBtwRecords(): BtwRecordView[] {
	return [...askedRecords, ...btwHistoryRecords].map((record) =>
		record.inject === "pending" && injectedIds.has(record.id)
			? { ...record, inject: "sent" }
			: record,
	);
}

/** A follow-up turn on a saved record: asked records gain it; seeded ones answer as they are. */
function followUpRecord(recordId: string, question: string): BtwRecordView | undefined {
	const index = askedRecords.findIndex((r) => r.id === recordId);
	if (index < 0) return currentBtwRecords().find((r) => r.id === recordId);
	const record = askedRecords[index]!;
	const turn = {
		question,
		answer: BTW_CANNED_ANSWER,
		status: "complete" as const,
		createdAt: at(0),
		updatedAt: at(0),
	};
	const updated = { ...record, followUps: [...(record.followUps ?? []), turn], updatedAt: at(0) };
	askedRecords[index] = updated;
	return updated;
}

/** Transcript turns for one record (btwPage answer): the question, then each follow-up. */
export function btwTranscriptFor(recordId: string): BtwTranscriptTurnView[] {
	const record = currentBtwRecords().find((r) => r.id === recordId);
	if (!record) return [];
	const first: BtwTranscriptTurnView = {
		key: `${record.id}:0`,
		index: 0,
		question: record.question,
		answer: record.answer,
		status: record.status,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		...(record.error ? { error: record.error } : {}),
		...(record.inject ? { inject: record.inject } : {}),
	};
	const followUps = (record.followUps ?? []).map((turn, i): BtwTranscriptTurnView => ({
		key: `${record.id}:${i + 1}`,
		index: i + 1,
		question: turn.question,
		answer: turn.answer,
		status: turn.status,
		createdAt: turn.createdAt,
		updatedAt: turn.updatedAt,
		...(turn.error ? { error: turn.error } : {}),
		...(turn.inject ? { inject: turn.inject } : {}),
	}));
	return [first, ...followUps];
}

/**
 * The session calls the /btw sheet makes: the saved list, search, a thread page, asking and
 * following up (answered at once with a canned reply), cancel, copy, the promote preview (eligible
 * only for a single complete turn, as the server decides), promote and `btwInject`, which marks a
 * pending steering prompt sent. `injectRefusal` makes the send fail with that reason instead, as a
 * session that dropped the prompt would.
 */
export function btwCalls(injectRefusal?: string): CallHandlers {
	const find = (recordId: unknown) => currentBtwRecords().find((r) => r.id === String(recordId));
	return {
		btwList: () => ({ records: currentBtwRecords(), total: currentBtwRecords().length }),
		btwSearch: () => ({ records: currentBtwRecords(), total: currentBtwRecords().length }),
		btwPage: (args) => {
			const turns = btwTranscriptFor(String(args[0]));
			return { turns, total: turns.length };
		},
		btwStart: (args) => {
			const record: BtwRecordView = {
				id: `btw_demo_${nextAskedId++}`,
				leafId: "leaf_131",
				question: String(args[0] ?? ""),
				answer: BTW_CANNED_ANSWER,
				status: "complete",
				createdAt: at(0),
				updatedAt: at(0),
			};
			askedRecords = [record, ...askedRecords];
			return { record };
		},
		btwFollowUp: (args) => ({ record: followUpRecord(String(args[0]), String(args[1] ?? "")) }),
		btwCancel: (args) => ({ record: find(args[0]) }),
		btwCopy: (args) => ({ text: find(args[0])?.answer ?? null }),
		btwPromote: () => ({}),
		btwPromotePreview: (args) => {
			const recordId = String(args[0]);
			const record = find(recordId);
			const turns = 1 + (record?.followUps?.length ?? 0);
			const eligible = turns === 1 && record?.status === "complete";
			return {
				recordId,
				question: record?.question ?? "",
				leafId: record?.leafId ?? null,
				sessionId: "sess_09a41c",
				eligible,
				reason: eligible
					? undefined
					: turns > 1
						? "multi-turn side conversations remain in BTW history"
						: "the answer is not ready",
				turns,
			};
		},
		btwInject: (args) => {
			if (injectRefusal !== undefined) throw new Error(injectRefusal);
			const recordId = String(args[0]);
			injectedIds.add(recordId);
			return { record: currentBtwRecords().find((r) => r.id === recordId) };
		},
	};
}

/** Answer the /btw sheet's calls (see {@link btwCalls}) and forget what earlier seeds asked or sent. */
export function answerBtwHistory(injectRefusal?: string): void {
	injectedIds.clear();
	askedRecords = [];
	answerCalls(btwCalls(injectRefusal));
}

// ---------------------------------------------------------------------------
// Session tree (SessionTreePanel): session answer for getSessionGraph.
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
	node("n05", "n02", "assistant", "SessionTreePanel shows the session tree", 92, 1),
	node("n06", "n05", "user", "Keep the legacy header path in the story too", 90, 1),
	node("n07", "n06", "assistant", "Added a variant for the paged graph", 89, 1),
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

/** A tree with a past `ask` answer (n03): picking it probes, then re-asks in the composer. */
export const sessionGraphPageAsk: GraphPage = {
	...sessionGraphPage,
	revision: "rev_19",
	leafId: "n05",
	nodes: [
		node("n01", null, "user", "Pick a store for the sessions", 40, 1),
		node("n02", "n01", "assistant", "[ask]", 39, 1),
		node("n03", "n02", "ask", "User answers: store = sqlite", 38, 1),
		node("n04", "n03", "assistant", "Using SQLite for the session store", 37, 1),
		node("n05", "n04", "user", "Thanks, go ahead", 36, 0),
	],
};

/** The probe answer for `sessionGraphPageAsk`'s ask node: the form the session re-asks. */
export const sessionGraphAskProbe = {
	reopenAsk: {
		toolCallId: "call_ask_store",
		html: `<form>
  <fieldset>
    <legend>Which store should hold sessions?</legend>
    <label><input type="radio" name="store" value="sqlite" checked> SQLite</label>
    <label><input type="radio" name="store" value="redis"> Redis</label>
  </fieldset>
</form>`,
	},
	revision: "rev_19",
};

// ---------------------------------------------------------------------------
// Compaction: session answer for compactionSnapshot, plus store slice builders.
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
	{ ts: at(14), level: "info", source: "transport", message: "/ws socket opened (fresh priming)" },
	{
		ts: at(13),
		level: "info",
		source: "roster",
		message: "session process d_7f3a registered (omp-web)",
	},
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
		message: "session process d_7f3a attached",
		workspaceId: "d_7f3a",
	},
	{
		ts: at(20),
		level: "info",
		source: "roster",
		message: "session process d_b201 attached",
		workspaceId: "d_b201",
	},
	{
		ts: at(11),
		level: "warn",
		source: "roster",
		message: "session process d_b201 missed a heartbeat",
		workspaceId: "d_b201",
	},
	{
		ts: at(10),
		level: "info",
		source: "roster",
		message: "session process d_b201 heartbeat restored",
		workspaceId: "d_b201",
	},
	{
		ts: at(3),
		level: "error",
		source: "roster",
		message: "session process d_c4e9 refused attach: wrong token",
		workspaceId: "d_c4e9",
	},
];

// ---------------------------------------------------------------------------
// Prompt history (PromptHistoryPicker): localStorage "omp-web:history", oldest first.
// ---------------------------------------------------------------------------

export const promptHistoryEntries: string[] = [
	"Read the overlay components and list their props",
	"Split the stories by tier and keep fixtures typed",
	"Why does SessionTreePanel reload the graph page?",
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

/** The SDK's account-risk prompt for a `login-warning` provider, asked before the sign-in URL. */
export const loginRiskPrompt: NonNullable<AppState["loginCodeRequest"]> = {
	requestId: "login_4",
	title:
		'⚠ Google Antigravity (Gemini, Claude, GPT-OSS): use at your own risk\n\nGoogle\'s Antigravity terms do not allow signing in from third-party tools like omp, and Google has suspended accounts that did. If you depend on this Google account, use GEMINI_API_KEY (AI Studio) or google-vertex instead.\n\nType "yes" to accept the risk and continue',
	placeholder: "yes",
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

/** What `ctx.ui.setStatus("git-branch", …)` becomes: a status bar under the composer. */
export const statusBarRequest: BrowserUiRequest = {
	requestId: "bui_4",
	contribution: {
		id: "status:git-branch",
		kind: "panel",
		owner: "terminal-hooks",
		title: "Status: git-branch",
		payload: { blocks: [{ type: "text", text: "feat/login-fix · 2 ahead" }] },
		version: 1,
	},
	scope: undefined,
	busy: false,
	error: null,
};
