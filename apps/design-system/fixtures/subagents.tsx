import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import { type JSX, onMount } from "solid-js";
import type { SettingsModel, SubagentMessagesResult } from "#lib/wire/protocol";
import { createHistoryBuilder } from "../../web/chat/history-items";
import { DockPane } from "../../web/components/ui/DockPane";
import { type ChatItem, type SubagentInfo, setState, type state } from "../../web/state";
import type { AdvisorOverview } from "../../web/store/subagents-advisor";
import type {
	SubagentNode,
	WorkerRecord,
	WorkerStatus,
	WorkersState,
} from "../../web/store/subagents";
import { type ActivitiesMode, openActivities, setActivitiesMode } from "../../web/store/activities";
import { subagentForest, workerKey } from "../../web/store/subagents";
import { flattenSubagentTree } from "../../web/subagents/tree";
import { answerCalls, type CallHandlers } from "../session";

/** Subagent fixtures for the session `sess_9d2c` on the omp-web repo (base 2026-10-09 10:00 UTC). */

const T0 = Date.parse("2026-10-09T10:00:00Z");
const at = (minute: number): number => T0 + minute * 60_000;

export const SESSION_ID = "sess_9d2c";
const SONNET = "claude-sonnet-4-5";
const GPT = "gpt-5";

const SESSIONS_ROOT = "/home/joshua/.omp/agent/sessions";
const subFile = (id: string): string => `${SESSIONS_ROOT}/omp-web/2026-10-09T09-40-12/${id}.jsonl`;

type TranscriptMessage = Extract<AgentMessage, { role: "user" | "assistant" | "toolResult" }>;
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type AssistantPart = AssistantMessage["content"][number];
type TranscriptEntry = SubagentMessagesResult["entries"][number];

/** SubagentInfo plus the extras the inspector and controls read, typed for fixtures. */
export interface SubagentFixture extends SubagentInfo {
	status: WorkerStatus;
	model?: string;
	sessionFile?: string;
	tokensUsed?: number;
	requests?: number;
	cost?: number;
	contextTokens?: number;
	contextWindow?: number;
	context?: string[];
	lineage?: string[];
	patch?: string;
	changedFiles?: string[];
	output?: string;
	artifactAvailability: "available" | "missing";
	hasHistory: boolean;
	revivable: boolean;
}

function usage(input: number, output: number): AssistantMessage["usage"] {
	const inputCost = input * 3e-6;
	const outputCost = output * 15e-6;
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: {
			input: inputCost,
			output: outputCost,
			cacheRead: 0,
			cacheWrite: 0,
			total: inputCost + outputCost,
		},
	};
}

function user(text: string, minute: number): TranscriptMessage {
	return { role: "user", content: text, timestamp: at(minute) };
}

function assistant(turn: {
	model: string;
	minute: number;
	stopReason: AssistantMessage["stopReason"];
	input: number;
	output: number;
	content: AssistantPart[];
}): AssistantMessage {
	return {
		role: "assistant",
		content: turn.content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: turn.model,
		usage: usage(turn.input, turn.output),
		stopReason: turn.stopReason,
		timestamp: at(turn.minute),
	};
}

function toolResult(
	toolCallId: string,
	toolName: string,
	text: string,
	minute: number,
	isError = false,
): TranscriptMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: at(minute),
	};
}

/** One transcript file: its entries with the byte offset each ends at, as the server pages them. */
export interface SubagentTranscriptFile {
	sessionFile: string;
	entries: TranscriptEntry[];
	messages: TranscriptMessage[];
	/** `ends[i]` is the byte offset just past entry `i`; a cursor always sits on one of these. */
	ends: number[];
}

function transcript(
	sessionFile: string,
	prefix: string,
	messages: TranscriptMessage[],
): SubagentTranscriptFile {
	const entries: TranscriptEntry[] = messages.map((message, index) => ({
		type: "message",
		id: `${prefix}${index + 1}`,
		parentId: index === 0 ? null : `${prefix}${index}`,
		timestamp: new Date(message.timestamp).toISOString(),
		message,
	}));
	let offset = 0;
	const ends = entries.map((entry) => {
		offset += JSON.stringify(entry).length + 1;
		return offset;
	});
	return { sessionFile, entries, messages, ends };
}

/**
 * One `getSubagentMessages` page, shaped like the server's: whole entries from `fromByte`, at most
 * `maxBytes` (always at least one), `hasMore` while entries remain and `nextByte` the cursor for the
 * next read. A cursor past the end of the file means the file shrank, so the page restarts at 0 with
 * `reset`. Reading from the end returns no entries and the same cursor, so the catch-up loop ends.
 */
export function transcriptPage(
	file: SubagentTranscriptFile,
	fromByte: number,
	maxBytes: number,
): SubagentMessagesResult {
	const total = file.ends.at(-1) ?? 0;
	const reset = fromByte > total;
	const start = reset ? 0 : fromByte;
	const first = file.ends.filter((end) => end <= start).length;
	const base = first === 0 ? 0 : (file.ends[first - 1] ?? 0);
	let last = first;
	while (
		last < file.entries.length &&
		(last === first || (file.ends[last] ?? 0) - base <= maxBytes)
	) {
		last++;
	}
	const entries = file.entries.slice(first, last);
	return {
		sessionFile: file.sessionFile,
		fromByte: start,
		nextByte: last === first ? start : (file.ends[last - 1] ?? start),
		hasMore: last < file.entries.length,
		reset,
		entries,
		messages: file.messages.slice(first, last),
	};
}

const exploreTranscript = transcript(subFile("FixtureBuilder.ChatMap"), "c", [
	user(
		"Map how assistant blocks become tool cards in the chat view. Name the file and function that splits them.",
		1,
	),
	assistant({
		model: SONNET,
		minute: 2,
		stopReason: "toolUse",
		input: 1840,
		output: 212,
		content: [
			{ type: "text", text: "Starting from the chat item types and the card renderer." },
			{
				type: "toolCall",
				id: "toolu_01A",
				name: "grep",
				arguments: { pattern: "ToolCard", path: "apps/web/components/chat" },
			},
		],
	}),
	toolResult(
		"toolu_01A",
		"grep",
		"apps/web/components/chat/ChatScreen.tsx:88: <ToolCard item={item} />\napps/web/components/chat/ToolCard.tsx:14: export function ToolCard(props: ToolCardProps)",
		2,
	),
	assistant({
		model: SONNET,
		minute: 3,
		stopReason: "toolUse",
		input: 2310,
		output: 146,
		content: [
			{
				type: "toolCall",
				id: "toolu_01B",
				name: "read",
				arguments: { path: "apps/web/components/chat/ChatScreen.tsx", offset: 70, limit: 24 },
			},
		],
	}),
	toolResult(
		"toolu_01B",
		"read",
		"70\tconst blocks = createMemo(() => groupBlocks(props.items));\n71\t<For each={blocks()}>\n72\t\t{(block) => <BlockView block={block} />}\n73\t</For>",
		3,
	),
	assistant({
		model: SONNET,
		minute: 5,
		stopReason: "stop",
		input: 2764,
		output: 388,
		content: [
			{
				type: "text",
				text: "Tool cards come from `groupBlocks()` in `apps/web/components/chat/blocks.ts`. An assistant turn is split at each `toolCall` part: text before a call stays a text block, and consecutive calls merge into one card group.",
			},
		],
	}),
]);

/** A long assignment (more than 8 lines) so the agent view folds it behind Show all. */
const BUILDER_ASSIGNMENT = [
	"## Goal",
	"Add a retry badge to tool cards that failed once and then succeeded. Keep the header layout unchanged.",
	"",
	"## Context",
	"- Tool cards live in `apps/web/components/chat/tools/ToolCard.tsx`; the item type is `ToolItem` in `apps/web/state.ts`.",
	"- The header already shows a duration chip. The badge should take that slot's neighbor, not a new row.",
	"- A call counts as retried when an earlier call with the same name and arguments ended in error.",
	"",
	"## Constraints",
	"- Do not touch the collapsed header: it truncates the tool name at 60 characters.",
	"- Run `bun run check:types` before reporting back.",
	"- Report the files you changed and anything you left undone.",
].join("\n");

const builderTranscript = transcript(subFile("FixtureBuilder"), "b", [
	user(BUILDER_ASSIGNMENT, 2),
	assistant({
		model: SONNET,
		minute: 3,
		stopReason: "toolUse",
		input: 4210,
		output: 188,
		content: [
			{ type: "text", text: "Looking at how the card header and item type fit together first." },
			{
				type: "toolCall",
				id: "toolu_02A",
				name: "read",
				arguments: { path: "apps/web/components/chat/tools/ToolCard.tsx", offset: 30, limit: 20 },
			},
		],
	}),
	toolResult(
		"toolu_02A",
		"read",
		[
			"30\texport function ToolCard(props: ToolCardProps) {",
			"31\t\tconst duration = createMemo(() => formatToolDuration(props.item));",
			"32\t\treturn (",
			'33\t\t\t<section class="tool-card">',
			"34\t\t\t\t<header>",
			'35\t\t\t\t\t<span class="tool-name">{props.item.name}</span>',
			'36\t\t\t\t\t<span class="tool-duration">{duration()}</span>',
			"37\t\t\t\t</header>",
		].join("\n"),
		3,
	),
	assistant({
		model: SONNET,
		minute: 4,
		stopReason: "toolUse",
		input: 9120,
		output: 640,
		content: [
			{
				type: "thinking",
				thinking:
					"The header already has a duration chip, so the badge can take that slot instead of adding a row.",
			},
			{
				type: "text",
				text: "I'll add a `retried` flag on the tool item first, then render the badge in ToolCard.",
			},
			{
				type: "toolCall",
				id: "toolu_02B",
				name: "edit",
				arguments: {
					path: "apps/web/state.ts",
					old_string: "\tstatus: ToolStatus;\n\toutput?: string;",
					new_string:
						"\tstatus: ToolStatus;\n\t/** An earlier identical call failed before this one succeeded. */\n\tretried?: boolean;\n\toutput?: string;",
				},
			},
		],
	}),
	toolResult("toolu_02B", "edit", "Applied 1 edit to apps/web/state.ts", 5),
	assistant({
		model: SONNET,
		minute: 6,
		stopReason: "toolUse",
		input: 11840,
		output: 412,
		content: [
			{ type: "text", text: "Now the badge in ToolCard, then a typecheck pass." },
			{
				type: "toolCall",
				id: "toolu_02C",
				name: "bash",
				arguments: { command: "bun run check:types" },
			},
		],
	}),
	toolResult(
		"toolu_02C",
		"bash",
		"apps/web/components/chat/tools/ToolCard.tsx(42,18): error TS2339: Property 'retried' does not exist on type 'ToolItem'.",
		7,
		true,
	),
	assistant({
		model: SONNET,
		minute: 8,
		stopReason: "toolUse",
		input: 12604,
		output: 228,
		content: [
			{
				type: "text",
				text: "`ToolItem` is derived from `ChatItem` in state.ts, so the field has to land there. Fixing the narrowing in ToolCard next.",
			},
			{
				type: "toolCall",
				id: "toolu_02D",
				name: "edit",
				arguments: {
					path: "apps/web/components/chat/tools/ToolCard.tsx",
					old_string: '\t\t\t\t\t<span class="tool-duration">{duration()}</span>',
					new_string:
						'\t\t\t\t\t<span class="tool-duration">{duration()}</span>\n\t\t\t\t\t<Show when={props.item.retried}>\n\t\t\t\t\t\t<span class="tool-badge">retried</span>\n\t\t\t\t\t</Show>',
				},
			},
		],
	}),
]);

const advisorTranscript = transcript(subFile("FixtureBuilder.AdvisorA"), "a", [
	user("Review the retry-badge plan against the tool-card render path.", 9),
	assistant({
		model: GPT,
		minute: 10,
		stopReason: "stop",
		input: 3180,
		output: 294,
		content: [
			{
				type: "text",
				text: "Keep the badge out of the collapsed header. Collapsed cards already truncate the tool name at 60 characters, so a badge there hides the name. Put it beside the duration chip in the expanded header.",
			},
		],
	}),
]);

const docsTranscript = transcript(subFile("DocsSweep"), "d", [
	user("Sweep docs/ for stale tool-card screenshots.", 4),
	assistant({
		model: SONNET,
		minute: 5,
		stopReason: "stop",
		input: 2210,
		output: 176,
		content: [
			{
				type: "text",
				text: "Found four screenshots that show the pre-consolidation card layout. Parking here so the reviewer can see the list before I touch the images.",
			},
		],
	}),
]);

/** Transcripts by subagent id. `FixtureBuilder.ReviewPass` has none: its artifact is missing. */
export const subagentTranscripts: Record<string, SubagentTranscriptFile> = {
	"FixtureBuilder.ChatMap": exploreTranscript,
	FixtureBuilder: builderTranscript,
	"FixtureBuilder.AdvisorA": advisorTranscript,
	DocsSweep: docsTranscript,
	// Stopped mid-run: the transcript is on disk, so the agent can resume from it.
	"FixtureBuilder.ReviewPass.TypesCheck": transcript(
		subFile("FixtureBuilder.ReviewPass.TypesCheck"),
		"t",
		[
			user("Run the typecheck sweep over apps/ and report errors by file.", 6),
			assistant({
				model: SONNET,
				minute: 7,
				stopReason: "aborted",
				input: 1840,
				output: 92,
				content: [
					{
						type: "text",
						text: "Starting with apps/web, then apps/session. Stopped by the reviewer before the first run finished.",
					},
				],
			}),
		],
	),
	// Queued, not started: the file exists but holds nothing yet.
	"FixtureBuilder.LintPass": transcript(subFile("FixtureBuilder.LintPass"), "l", []),
};

/** The chat items a fixture transcript builds, through the same builder the store uses. */
export function subagentTranscriptItems(id: string): ChatItem[] {
	const file = subagentTranscripts[id];
	if (file === undefined) throw new Error(`no transcript for ${id}`);
	return createHistoryBuilder().append(file.messages).items;
}

export const subagentInfos: SubagentFixture[] = [
	{
		id: "FixtureBuilder.ChatMap",
		index: 0,
		agent: "explore",
		description: "Map the chat pipeline",
		task: "Map how assistant blocks become tool cards in the chat view.",
		status: "completed",
		lastUpdate: at(5),
		parentToolCallId: "toolu_01P1",
		model: SONNET,
		sessionFile: subFile("FixtureBuilder.ChatMap"),
		tokensUsed: 58210,
		requests: 7,
		cost: 0.142,
		contextTokens: 41200,
		contextWindow: 200000,
		context: [
			"apps/web/components/chat/ChatScreen.tsx",
			"apps/web/components/chat/tools/ToolCard.tsx",
			"apps/web/components/chat/blocks.ts",
		],
		lineage: ["main › toolu_01P1 › FixtureBuilder › FixtureBuilder.ChatMap"],
		output:
			"Tool cards come from groupBlocks() in apps/web/components/chat/blocks.ts. An assistant turn is split at each toolCall part.",
		artifactAvailability: "available",
		hasHistory: true,
		revivable: false,
	},
	{
		id: "FixtureBuilder",
		index: 1,
		agent: "task",
		description: "Retry badge on tool cards",
		task: "Add a retry badge to tool cards that failed once and then succeeded.",
		status: "running",
		lastUpdate: at(11),
		parentToolCallId: "toolu_01P1",
		model: SONNET,
		sessionFile: subFile("FixtureBuilder"),
		tokensUsed: 102774,
		requests: 19,
		cost: 0.861,
		contextTokens: 61000,
		contextWindow: 200000,
		context: [
			"apps/web/components/chat/tools/ToolCard.tsx",
			"apps/web/state.ts",
			"apps/web/components/chat/blocks.ts",
		],
		lineage: ["main › toolu_01P1 › FixtureBuilder"],
		patch: [
			"--- a/apps/web/components/chat/ToolCard.tsx",
			"+++ b/apps/web/components/chat/ToolCard.tsx",
			"@@ -38,7 +38,11 @@ export function ToolCard(props: ToolCardProps) {",
			'   <span class="tool-duration">{duration()}</span>',
			"+  <Show when={props.item.retried}>",
			'+    <span class="tool-badge">retried</span>',
			"+  </Show>",
			"   </header>",
		].join("\n"),
		changedFiles: ["apps/web/components/chat/tools/ToolCard.tsx", "apps/web/state.ts"],
		artifactAvailability: "available",
		hasHistory: true,
		revivable: false,
	},
	{
		id: "FixtureBuilder.ReviewPass",
		index: 2,
		agent: "review",
		description: "Review retry badge diff",
		status: "failed",
		lastUpdate: at(8),
		parentToolCallId: "toolu_01P1",
		model: SONNET,
		tokensUsed: 24011,
		requests: 4,
		cost: 0.052,
		output:
			"Error: session file rotated before the review pass finished. The artifact is missing, so no transcript can be replayed.",
		artifactAvailability: "missing",
		hasHistory: false,
		revivable: false,
	},
	{
		id: "FixtureBuilder.AdvisorA",
		index: 3,
		agent: "advisor",
		description: "Architecture advisor",
		status: "running",
		lastUpdate: at(10),
		parentToolCallId: "toolu_01P1",
		model: GPT,
		sessionFile: subFile("FixtureBuilder.AdvisorA"),
		tokensUsed: 31480,
		requests: 3,
		cost: 0.204,
		lineage: ["main › toolu_01P1 › FixtureBuilder › FixtureBuilder.AdvisorA"],
		artifactAvailability: "available",
		hasHistory: true,
		revivable: false,
	},
	{
		id: "DocsSweep",
		index: 4,
		agent: "task",
		description: "Docs sweep",
		task: "Sweep docs/ for stale tool-card screenshots.",
		status: "parked",
		lastUpdate: at(5),
		parentToolCallId: "toolu_01P4",
		model: SONNET,
		sessionFile: subFile("DocsSweep"),
		tokensUsed: 40210,
		requests: 5,
		cost: 0.091,
		context: ["docs/chat/tool-cards.md", "docs/img/tool-card-old.png"],
		artifactAvailability: "available",
		hasHistory: true,
		revivable: true,
	},
	{
		id: "FixtureBuilder.ReviewPass.TypesCheck",
		index: 5,
		agent: "task",
		description: "Typecheck sweep",
		status: "started",
		lastUpdate: at(11.5),
		parentToolCallId: "toolu_01P1",
		model: SONNET,
		tokensUsed: 4120,
		requests: 2,
		cost: 0.018,
		artifactAvailability: "available",
		hasHistory: false,
		revivable: false,
	},
];

function workerRecord(sub: SubagentFixture): WorkerRecord {
	return {
		id: sub.id,
		agentId: sub.id,
		sessionId: SESSION_ID,
		key: workerKey(SESSION_ID, sub.id),
		displayName: sub.description ?? sub.id,
		status: sub.status,
		kind: sub.agent,
		task: sub.task,
		description: sub.description,
		parentToolCallId: sub.parentToolCallId,
		model: sub.model,
		usage:
			sub.tokensUsed === undefined
				? undefined
				: {
						tokens: sub.tokensUsed,
						requests: sub.requests ?? 0,
						cost: sub.cost ?? 0,
						contextTokens: sub.contextTokens,
						contextWindow: sub.contextWindow,
					},
		artifactAvailability: sub.artifactAvailability,
		sessionFile: sub.sessionFile ?? null,
		hasHistory: sub.hasHistory,
		lastActivity: sub.lastUpdate,
		createdAt: sub.lastUpdate - 4 * 60_000,
		adopted: false,
		revivable: sub.revivable,
	};
}

/** Worker records as the server lists them for SESSION_ID (order = panel order). */
export const subagentWorkers: WorkerRecord[] = subagentInfos.map(workerRecord);

export function subagentMapOf(infos: SubagentInfo[]): Map<string, SubagentInfo> {
	return new Map(infos.map((sub) => [sub.id, sub]));
}

export function workersStateOf(records: WorkerRecord[]): WorkersState {
	return {
		records: Object.fromEntries(records.map((record) => [record.key, record])),
		order: records.map((record) => record.key),
	};
}

const GOAL_OBJECTIVE = "Ship the subagent design-system stories against the real components";

function goalState(
	status: GoalModeState["goal"]["status"],
	tokensUsed: number,
	timeUsedSeconds: number,
	tokenBudget?: number,
): GoalModeState {
	return {
		enabled: true,
		mode: "active",
		goal: {
			id: "goal_4f1a",
			objective: GOAL_OBJECTIVE,
			status,
			tokenBudget,
			tokensUsed,
			timeUsedSeconds,
			createdAt: at(0),
			updatedAt: at(22),
		},
	};
}

export const goalActive = goalState("active", 48_200, 1320, 150_000);
export const goalPaused = goalState("paused", 91_400, 2710, 150_000);
export const goalBudgetLimited = goalState("budget-limited", 150_400, 4180, 150_000);

export const advisorOverview: AdvisorOverview = {
	configured: true,
	roleResolvable: true,
	active: true,
	advisors: [
		{ name: "architect", status: "watching", yielded: false },
		{ name: "reviewer-gpt5", status: "idle", yielded: true },
	],
};

export const advisorDisabled: AdvisorOverview = {
	configured: false,
	roleResolvable: true,
	active: false,
	advisors: [],
};

export const advisorNoModel: AdvisorOverview = {
	configured: false,
	roleResolvable: false,
	active: false,
	advisors: [],
};

export const advisorStats = { cost: 0.318, tokens: { total: 84032 }, messages: { total: 12 } };

export const advisorWarnings = [
	"architect: model gpt-5 has no reasoning budget; using provider default",
	"reviewer-gpt5: context window trimmed to 128k",
];

export const advisorHistoryPage = {
	text: [
		"[architect] Keep the badge out of the collapsed header. Collapsed cards already truncate the tool name at 60 characters.",
		"[reviewer-gpt5] Agreed. Put it beside the duration chip in the expanded header and cover the retried path in ToolCard.test.tsx.",
	].join("\n\n"),
	nextCursor: "c2",
};

interface LoopPolicyFixture {
	hasPostPromptWork: boolean;
	queuedMessageCount: number;
	isStreaming: boolean;
	loop: {
		status: "inactive" | "running" | "paused" | "stopped";
		iteration: number;
		nextRunAt?: number;
		stopReason?: string;
	};
	capabilities: { boundedLoop: boolean; atomicPauseAll: boolean; pauseAllReason?: string };
}

export const loopPolicyIdle: LoopPolicyFixture = {
	hasPostPromptWork: false,
	queuedMessageCount: 0,
	isStreaming: false,
	loop: { status: "inactive", iteration: 0 },
	capabilities: { boundedLoop: true, atomicPauseAll: true },
};

export const loopPolicyRunning: LoopPolicyFixture = {
	hasPostPromptWork: true,
	queuedMessageCount: 1,
	isStreaming: true,
	loop: { status: "running", iteration: 3, nextRunAt: at(14) },
	capabilities: { boundedLoop: true, atomicPauseAll: true },
};

export const loopPolicyPaused: LoopPolicyFixture = {
	hasPostPromptWork: true,
	queuedMessageCount: 0,
	isStreaming: false,
	loop: { status: "paused", iteration: 2 },
	capabilities: { boundedLoop: true, atomicPauseAll: true },
};

export const loopPolicyStopped: LoopPolicyFixture = {
	hasPostPromptWork: false,
	queuedMessageCount: 0,
	isStreaming: false,
	loop: { status: "stopped", iteration: 6, stopReason: "limit reached (6/6)" },
	capabilities: {
		boundedLoop: true,
		atomicPauseAll: false,
		pauseAllReason: "pause-all needs a single active loop",
	},
};

export const loopPreviewOk = {
	ok: true,
	summary: "every 10m: run bun run check:types until it passes (max 6 iterations)",
};

interface VibeWorkerFixture {
	id: string;
	name: string;
	cli?: string;
	state?: string;
	turns?: number;
	queued?: number;
}

export const vibeDisabled: { enabled: boolean; workers: VibeWorkerFixture[] } = {
	enabled: false,
	workers: [],
};

export const vibeEnabled = {
	enabled: true,
	workers: [
		{ id: "vibe_a1", name: "api-audit", cli: "claude", state: "running", turns: 4, queued: 1 },
		{ id: "vibe_b2", name: "css-sweep", cli: "codex", state: "idle", turns: 9, queued: 0 },
	] satisfies VibeWorkerFixture[],
};

/** Reads the first argument of a call as a plain record (empty when absent). */
export function argRecord(args: unknown[]): Partial<Record<string, unknown>> {
	const first: unknown = args[0];
	if (typeof first !== "object" || first === null) return {};
	return { ...first };
}

const defaultCalls: CallHandlers = {
	workerList: () => subagentWorkers,
	getSubagentMessages: (args) => {
		const { subagentId, fromByte, maxBytes } = argRecord(args);
		const found = typeof subagentId === "string" ? subagentTranscripts[subagentId] : undefined;
		if (found === undefined) throw new Error(`no transcript for ${String(subagentId)}`);
		return transcriptPage(
			found,
			typeof fromByte === "number" ? fromByte : 0,
			typeof maxBytes === "number" ? maxBytes : Number.POSITIVE_INFINITY,
		);
	},
	subagentSteer: () => ({ ok: true }),
	subagentAbort: () => ({ ok: true }),
	advisorGetStatus: (args) => {
		const section = argRecord(args).section;
		if (section === "stats") return advisorStats;
		if (section === "warnings") return { warnings: advisorWarnings };
		return advisorOverview;
	},
	advisorConfigure: () => ({ enabled: true }),
	advisorTranscript: () => advisorHistoryPage,
	loopPolicy: () => loopPolicyIdle,
	loopPreview: () => loopPreviewOk,
	loopStart: () => ({ ok: true }),
	loopPause: () => ({ ok: true }),
	loopResume: () => ({ ok: true }),
	loopCancel: () => ({ ok: true }),
	goalBudget: () => ({ ok: true }),
	vibeStatus: () => vibeDisabled,
	vibeSetMode: () => ({ enabled: true }),
	vibeSend: () => ({ ok: true }),
	vibeWait: () => ({ ok: true }),
	vibeKill: () => ({ ok: true }),
	vibeKillAll: () => ({ killed: 0 }),
	vibeRehydrate: () => ({ restored: 0 }),
};

/** Default answers for every subagent-area call, with per-variant overrides applied on top. */
export function subagentCalls(overrides: CallHandlers = {}): CallHandlers {
	return { ...defaultCalls, ...overrides };
}

/**
 * The real dock pane on the right of a fixed-height frame, like the app body hosts it: the pane
 * stretches to the frame's height and its body gives a flush panel its column layout.
 */
export function DockFrame(props: {
	title: string;
	width: number;
	flush?: boolean;
	/** Header controls beside the close button, as the dock kind supplies them. */
	actions?: JSX.Element;
	children: JSX.Element;
}): JSX.Element {
	return (
		<div
			class="ds-frame ds-frame-tall"
			style={{
				display: "flex",
				"justify-content": "flex-end",
				// The dock's layout width comes only from this variable (prefs/dock.ts sets it on the app).
				"--dock-w": `${props.width}px`,
			}}
		>
			<DockPane
				title={props.title}
				width={props.width}
				minWidth={320}
				maxWidth={900}
				onWidth={() => undefined}
				onClose={() => undefined}
				flush={props.flush}
				actions={props.actions}
			>
				{props.children}
			</DockPane>
		</div>
	);
}

/**
 * Clicks each button whose trimmed label matches, once mounted: the same action a user takes to
 * load a lazily fetched section. Used only where the real component loads data on button press.
 */
export function ClickOnMount(props: { labels: string[]; children: JSX.Element }): JSX.Element {
	let host: HTMLDivElement | undefined;
	onMount(() => {
		const buttons = Array.from(host?.querySelectorAll("button") ?? []);
		for (const label of props.labels) {
			buttons.find((button) => button.textContent?.trim() === label)?.click();
		}
	});
	return (
		<div
			ref={(el) => {
				host = el;
			}}
		>
			{props.children}
		</div>
	);
}

/** Fixture info for one id. Throws on an unknown id. */
export function subagentById(id: string): SubagentInfo {
	const found = subagentInfos.find((sub) => sub.id === id);
	if (found === undefined) throw new Error(`unknown subagent fixture ${id}`);
	return found;
}

/**
 * Installs the subagent call handlers (defaults plus `calls`) and applies `patch` to the store.
 * Variant seeds run after the stage resets the store, so every variant starts from a known state.
 */
export function seedSubagents(calls: CallHandlers = {}, patch: Partial<typeof state> = {}): void {
	answerCalls(subagentCalls(calls));
	setState(patch);
}

// ---------------------------------------------------------------------------
// Agent tree: the session forest read by the subagent tree, agents panel,
// agent pane and activity bar. Parent links come from the roster.
// ---------------------------------------------------------------------------

interface AgentSpec {
	id: string;
	parentId?: string;
	agent: string;
	/** Absent on one agent so its title falls back to the first line of `assignment`. */
	description?: string;
	assignment?: string;
	status: WorkerStatus;
	parentToolCallId: string;
	startMin?: number;
	endMin?: number;
	progress?: Record<string, unknown>;
}

const SONNET_ID = "anthropic/claude-sonnet-4-5";
const OPUS_ID = "anthropic/claude-opus-4-1";

/**
 * Ids follow the SDK form: the requested name, nested children dotted onto their parent, and a
 * `-2` suffix when a sibling name repeats. `FixtureBuilder` is a root with a finished scout, a
 * running advisor, a failed review (whose aborted typecheck was rerun as `TypesCheck-2`) and a
 * pending lint pass. `DocsSweep` is a parked root with no model. Ids that have a fixture
 * transcript are listed in `subagentTranscripts`.
 */
const agentSpecs: AgentSpec[] = [
	{
		// Live line from the in-flight tool and its intent.
		id: "FixtureBuilder",
		agent: "task",
		description: "Retry badge on tool cards",
		assignment: BUILDER_ASSIGNMENT,
		status: "running",
		parentToolCallId: "toolu_01P1",
		startMin: 2,
		progress: {
			tokens: 48_200,
			cost: 0.412,
			contextTokens: 82_400,
			contextWindow: 200_000,
			durationMs: 548_000,
			currentTool: "edit",
			currentToolIntent: "Render the retried badge in the card header",
			resolvedModelIdentity: SONNET_ID,
			resolvedThinkingLevel: "high",
		},
	},
	{
		id: "FixtureBuilder.ChatMap",
		parentId: "FixtureBuilder",
		agent: "explore",
		description: "Map the chat pipeline",
		status: "completed",
		parentToolCallId: "toolu_01P1",
		startMin: 2.5,
		endMin: 5,
		progress: {
			tokens: 12_400,
			cost: 0.031,
			contextTokens: 41_200,
			contextWindow: 200_000,
			durationMs: 150_000,
			resolvedModelIdentity: SONNET_ID,
		},
	},
	{
		// Live line from the last finished tool, which failed (error color).
		id: "FixtureBuilder.AdvisorA",
		parentId: "FixtureBuilder",
		agent: "advisor",
		description: "Architecture advisor",
		status: "running",
		parentToolCallId: "toolu_01P1",
		startMin: 3,
		progress: {
			tokens: 9_400,
			cost: 0.052,
			contextTokens: 31_000,
			contextWindow: 200_000,
			durationMs: 420_000,
			lastTool: { tool: "read", intent: "Open the card header styles", isError: true },
			resolvedModelIdentity: OPUS_ID,
			resolvedThinkingLevel: "medium",
			advisor: true,
		},
	},
	{
		id: "FixtureBuilder.ReviewPass",
		parentId: "FixtureBuilder",
		agent: "review",
		description: "Review retry badge diff",
		status: "failed",
		parentToolCallId: "toolu_01P1",
		startMin: 5,
		endMin: 8,
		progress: {
			tokens: 21_800,
			cost: 0.094,
			contextTokens: 64_000,
			contextWindow: 200_000,
			durationMs: 180_000,
			resolvedModelIdentity: SONNET_ID,
		},
	},
	{
		id: "FixtureBuilder.ReviewPass.TypesCheck",
		parentId: "FixtureBuilder.ReviewPass",
		agent: "task",
		description: "Typecheck sweep",
		status: "aborted",
		parentToolCallId: "toolu_01P1",
		startMin: 6,
		endMin: 7.5,
		progress: { tokens: 3_100, cost: 0.008, durationMs: 90_000 },
	},
	{
		// Dedup suffix, and no description: the title is the first non-empty assignment line.
		id: "FixtureBuilder.ReviewPass.TypesCheck-2",
		parentId: "FixtureBuilder.ReviewPass",
		agent: "task",
		assignment:
			"\nRe-run the typecheck sweep on apps/web only.\nReport TypeScript errors grouped by file.",
		status: "completed",
		parentToolCallId: "toolu_01P1",
		startMin: 7.5,
		endMin: 9,
		progress: {
			tokens: 2_600,
			cost: 0.006,
			contextTokens: 9_800,
			contextWindow: 200_000,
			durationMs: 80_000,
			resolvedModelIdentity: SONNET_ID,
		},
	},
	{
		id: "FixtureBuilder.LintPass",
		parentId: "FixtureBuilder",
		agent: "task",
		description: "Lint changed files",
		status: "pending",
		parentToolCallId: "toolu_01P1",
	},
	{
		// Parked: the roster has no model, so the model part of line 3 is absent.
		id: "DocsSweep",
		agent: "task",
		description: "Docs sweep",
		status: "parked",
		parentToolCallId: "toolu_01P4",
		startMin: 1,
		endMin: 5,
		progress: {
			tokens: 6_400,
			cost: 0.019,
			contextTokens: 22_000,
			contextWindow: 200_000,
			durationMs: 240_000,
		},
	},
];

function agentInfoOf(spec: AgentSpec, index: number): SubagentInfo {
	return {
		id: spec.id,
		index,
		agent: spec.agent,
		description: spec.description,
		status: spec.status,
		lastUpdate: at(spec.endMin ?? 11.5),
		parentToolCallId: spec.parentToolCallId,
		progress: spec.progress,
		// A running agent's clock follows the real time, so it starts `durationMs` before now (like the
		// store does on a first progress frame); finished agents keep their fixed fixture times.
		startedAt:
			spec.status === "running" && typeof spec.progress?.durationMs === "number"
				? Date.now() - spec.progress.durationMs
				: spec.startMin === undefined
					? undefined
					: at(spec.startMin),
		endedAt: spec.endMin === undefined ? undefined : at(spec.endMin),
	};
}

function agentRecordOf(spec: AgentSpec, revivable = spec.status === "parked"): WorkerRecord {
	return {
		id: spec.id,
		agentId: spec.id,
		sessionId: SESSION_ID,
		key: workerKey(SESSION_ID, spec.id),
		displayName: spec.description ?? spec.id,
		status: spec.status,
		parentAgentId: spec.parentId,
		parentToolCallId: spec.parentToolCallId,
		kind: spec.agent,
		assignment: spec.assignment,
		description: spec.description,
		progress: spec.progress,
		artifactAvailability: "available",
		sessionFile: subFile(spec.id),
		hasHistory: true,
		lastActivity: at(spec.endMin ?? 11.5),
		createdAt: at(spec.startMin ?? 11),
		adopted: false,
		revivable,
	};
}

/** Live subagent mirror entries (`state.subagents`) for the agent tree. */
export const agentTreeInfos: SubagentInfo[] = agentSpecs.map(agentInfoOf);

/** Roster records for the agent tree; they carry the parent links that nest the rows. */
export const agentTreeWorkers: WorkerRecord[] = agentSpecs.map((spec) => agentRecordOf(spec));

/** Settings the tree row reads: the live line under running rows. */
export const agentSettingsModel: SettingsModel = {
	revision: 1,
	target: "current-session",
	tabs: [
		{
			id: "agents",
			label: "Agents",
			groups: [
				{
					name: "Subagents",
					items: [
						{
							path: "display.subagentLivePreview",
							label: "Live preview",
							description: "Show the tool a running agent is using.",
							type: "boolean",
							value: true,
							changed: false,
						},
					],
				},
			],
		},
	],
};

/**
 * Seeds the attached session with the agent forest, or an empty session with `empty`.
 * `display` also turns on the live-line setting the tree row reads (off by default, so rows show
 * three lines). `settled` finishes the running and pending agents, so nothing in the forest is active.
 * `revivable` lists aborted agents the roster reports as resumable (parked agents always are).
 */
export function seedAgentTree(
	options: {
		empty?: boolean;
		display?: boolean;
		settled?: boolean;
		/** Ids whose roster record reports a stopped (aborted) agent as resumable from its transcript. */
		revivable?: readonly string[];
	} = {},
): void {
	const specs =
		options.empty === true
			? []
			: agentSpecs.map((spec) =>
					options.settled === true && (spec.status === "running" || spec.status === "pending")
						? { ...spec, status: "completed" as const, endMin: spec.endMin ?? 11 }
						: spec,
				);
	const workers = specs.map((spec) =>
		agentRecordOf(spec, spec.status === "parked" || options.revivable?.includes(spec.id) === true),
	);
	const infos = specs.map(agentInfoOf);
	seedSubagents(
		{ workerList: () => workers },
		{
			currentWorkspaceId: SESSION_ID,
			workers: workersStateOf(workers),
			subagents: subagentMapOf(infos),
			settingsModel: options.display === true ? agentSettingsModel : null,
		},
	);
}

/**
 * Seeds the agent forest and opens the Activities panel in `mode`, with the subagent `agentId`
 * shown the way a row click does (expanded in the list in accordion, filling the panel in
 * detail). No id leaves the panel on its list.
 */
export function seedActivities(mode: ActivitiesMode, agentId?: string): void {
	seedAgentTree({ display: true });
	setActivitiesMode(mode);
	openActivities(agentId === undefined ? {} : { item: { section: "subagents", id: agentId } });
}

/** One node of the seeded forest by agent id. Call after `seedAgentTree`. Throws on an unknown id. */
export function agentNode(id: string): SubagentNode {
	const found = flattenSubagentTree(subagentForest()).find((node) => node.id === id);
	if (found === undefined) throw new Error(`unknown agent node ${id}`);
	return found;
}
