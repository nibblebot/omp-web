import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import { type JSX, onMount } from "solid-js";
import type { SettingsModel, SubagentMessagesResult } from "#lib/wire/protocol";
import { type SubagentInfo, setState, type state } from "../../web/state";
import type { AdvisorOverview } from "../../web/store/subagents-advisor";
import type {
	SubagentNode,
	WorkerRecord,
	WorkerStatus,
	WorkersState,
} from "../../web/store/subagents";
import { subagentForest, workerKey } from "../../web/store/subagents";
import { flattenSubagentTree } from "../../web/subagents/tree";
import { answerCalls, type CallHandlers } from "../daemon";

/** Subagent fixtures for the session `sess_9d2c` on the omp-web repo (base 2026-10-09 10:00 UTC). */

const T0 = Date.parse("2026-10-09T10:00:00Z");
const at = (minute: number): number => T0 + minute * 60_000;

export const SESSION_ID = "sess_9d2c";
const SONNET = "claude-sonnet-4-5";
const OPUS = "claude-opus-4-1";
const GPT = "gpt-5";

const subFile = (id: string): string =>
	`/home/joshua/.omp/sessions/omp-web/2026-10-09T09-40-12/${id}.jsonl`;

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
	unavailableReason?: string;
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

function transcript(
	sessionFile: string,
	prefix: string,
	messages: TranscriptMessage[],
): SubagentMessagesResult {
	const entries: TranscriptEntry[] = messages.map((message, index) => ({
		type: "message",
		id: `${prefix}${index + 1}`,
		parentId: index === 0 ? null : `${prefix}${index}`,
		timestamp: new Date(message.timestamp).toISOString(),
		message,
	}));
	return { sessionFile, fromByte: 0, nextByte: 0, reset: true, entries, messages };
}

const exploreTranscript = transcript(subFile("0-ChatMap"), "c", [
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

const builderTranscript = transcript(subFile("1-FixtureBuilder"), "b", [
	user(
		"Add a retry badge to tool cards that failed once and then succeeded. Keep the header layout unchanged.",
		7,
	),
	assistant({
		model: OPUS,
		minute: 8,
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
				id: "toolu_01C",
				name: "edit",
				arguments: { path: "apps/web/state.ts", reason: "add retried flag to ToolItem" },
			},
		],
	}),
	toolResult("toolu_01C", "edit", "Edited apps/web/state.ts (+1 -0)", 9),
	assistant({
		model: OPUS,
		minute: 10,
		stopReason: "toolUse",
		input: 11840,
		output: 412,
		content: [
			{ type: "text", text: "Now the badge in ToolCard, then a typecheck pass." },
			{
				type: "toolCall",
				id: "toolu_01D",
				name: "bash",
				arguments: { command: "bun run check:types" },
			},
		],
	}),
	toolResult(
		"toolu_01D",
		"bash",
		"apps/web/components/chat/ToolCard.tsx(42,18): error TS2339: Property 'retried' does not exist on type 'ToolItem'.",
		10,
		true,
	),
	assistant({
		model: OPUS,
		minute: 11,
		stopReason: "toolUse",
		input: 12604,
		output: 228,
		content: [
			{
				type: "text",
				text: "`ToolItem` is derived from `ChatItem` in state.ts, so the field has to land there. Fixing the narrowing in ToolCard next.",
			},
		],
	}),
]);

const advisorTranscript = transcript(subFile("3-AdvisorA"), "a", [
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

const docsTranscript = transcript(subFile("4-DocsSweep"), "d", [
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

/** Transcripts by subagent id. `2-ReviewPass` has none: its artifact is missing. */
export const subagentTranscripts: Record<string, SubagentMessagesResult> = {
	"0-ChatMap": exploreTranscript,
	"1-FixtureBuilder": builderTranscript,
	"3-AdvisorA": advisorTranscript,
	"4-DocsSweep": docsTranscript,
};

export const subagentInfos: SubagentFixture[] = [
	{
		id: "0-ChatMap",
		index: 0,
		agent: "explore",
		description: "Map the chat pipeline",
		task: "Map how assistant blocks become tool cards in the chat view.",
		status: "completed",
		lastUpdate: at(5),
		parentToolCallId: "toolu_01P0",
		model: SONNET,
		sessionFile: subFile("0-ChatMap"),
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
		lineage: ["main › toolu_01P0 › 0-ChatMap"],
		output:
			"Tool cards come from groupBlocks() in apps/web/components/chat/blocks.ts. An assistant turn is split at each toolCall part.",
		artifactAvailability: "available",
		hasHistory: true,
		revivable: false,
	},
	{
		id: "1-FixtureBuilder",
		index: 1,
		agent: "task",
		description: "Retry badge on tool cards",
		task: "Add a retry badge to tool cards that failed once and then succeeded.",
		status: "running",
		lastUpdate: at(11),
		parentToolCallId: "toolu_01P1",
		model: OPUS,
		sessionFile: subFile("1-FixtureBuilder"),
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
		lineage: ["main › toolu_01P1 › 1-FixtureBuilder"],
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
		id: "2-ReviewPass",
		index: 2,
		agent: "review",
		description: "Review retry badge diff",
		status: "failed",
		lastUpdate: at(8),
		parentToolCallId: "toolu_01P2",
		model: SONNET,
		tokensUsed: 24011,
		requests: 4,
		cost: 0.052,
		output:
			"Error: session file rotated before the review pass finished. The artifact is missing, so no transcript can be replayed.",
		unavailableReason: "artifact missing",
		artifactAvailability: "missing",
		hasHistory: false,
		revivable: false,
	},
	{
		id: "3-AdvisorA",
		index: 3,
		agent: "advisor",
		description: "Architecture advisor",
		status: "running",
		lastUpdate: at(10),
		parentToolCallId: "toolu_01P3",
		model: GPT,
		sessionFile: subFile("3-AdvisorA"),
		tokensUsed: 31480,
		requests: 3,
		cost: 0.204,
		lineage: ["main › toolu_01P3 › 3-AdvisorA"],
		artifactAvailability: "available",
		hasHistory: true,
		revivable: false,
	},
	{
		id: "4-DocsSweep",
		index: 4,
		agent: "task",
		description: "Docs sweep",
		task: "Sweep docs/ for stale tool-card screenshots.",
		status: "parked",
		lastUpdate: at(5),
		parentToolCallId: "toolu_01P4",
		model: SONNET,
		sessionFile: subFile("4-DocsSweep"),
		tokensUsed: 40210,
		requests: 5,
		cost: 0.091,
		context: ["docs/chat/tool-cards.md", "docs/img/tool-card-old.png"],
		artifactAvailability: "available",
		hasHistory: true,
		revivable: true,
	},
	{
		id: "5-TypesCheck",
		index: 5,
		agent: "task",
		description: "Typecheck sweep",
		status: "started",
		lastUpdate: at(11.5),
		parentToolCallId: "toolu_01P5",
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
		unavailableReason: sub.unavailableReason,
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
	active: true,
	advisors: [
		{ name: "architect", status: "watching", yielded: false },
		{ name: "reviewer-gpt5", status: "idle", yielded: true },
	],
};

export const advisorDisabled: AdvisorOverview = { configured: false, active: false, advisors: [] };

export const advisorStats = { cost: 0.318, tokens: 84032, messages: 12 };

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
		const id = argRecord(args).subagentId;
		const found = typeof id === "string" ? subagentTranscripts[id] : undefined;
		if (found === undefined) throw new Error(`no transcript for ${String(id)}`);
		return found;
	},
	subagentSteer: () => ({ ok: true }),
	subagentAbort: () => ({ ok: true }),
	advisorGetStatus: (args) => (argRecord(args).stats === true ? advisorStats : advisorOverview),
	advisorConfigure: (args) =>
		argRecord(args).probe === true ? advisorWarnings : { enabled: true },
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
// agent pane and running-agents counter. Parent links come from the roster.
// ---------------------------------------------------------------------------

interface AgentSpec {
	id: string;
	parentId?: string;
	agent: string;
	description: string;
	status: WorkerStatus;
	parentToolCallId: string;
	startMin?: number;
	endMin?: number;
	progress?: Record<string, unknown>;
}

const SONNET_ID = "anthropic/claude-sonnet-4-5";
const OPUS_ID = "anthropic/claude-opus-4-1";

/**
 * Ids reuse the subagent fixtures above so their transcripts load. `1-FixtureBuilder` is a root
 * with a finished scout, a running advisor, a failed review (which aborted its typecheck child)
 * and a pending lint pass. `4-DocsSweep` is a parked root.
 */
const agentSpecs: AgentSpec[] = [
	{
		id: "1-FixtureBuilder",
		agent: "task",
		description: "Retry badge on tool cards",
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
			resolvedModelIdentity: SONNET_ID,
			resolvedThinkingLevel: "high",
		},
	},
	{
		id: "0-ChatMap",
		parentId: "1-FixtureBuilder",
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
		id: "3-AdvisorA",
		parentId: "1-FixtureBuilder",
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
			currentTool: "read",
			resolvedModelIdentity: OPUS_ID,
			advisor: true,
		},
	},
	{
		id: "2-ReviewPass",
		parentId: "1-FixtureBuilder",
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
		id: "5-TypesCheck",
		parentId: "2-ReviewPass",
		agent: "task",
		description: "Typecheck sweep",
		status: "aborted",
		parentToolCallId: "toolu_01P1",
		startMin: 6,
		endMin: 7.5,
		progress: { tokens: 3_100, cost: 0.008, durationMs: 90_000 },
	},
	{
		id: "6-LintPass",
		parentId: "1-FixtureBuilder",
		agent: "task",
		description: "Lint changed files",
		status: "pending",
		parentToolCallId: "toolu_01P1",
	},
	{
		id: "4-DocsSweep",
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
		startedAt: spec.startMin === undefined ? undefined : at(spec.startMin),
		endedAt: spec.endMin === undefined ? undefined : at(spec.endMin),
	};
}

function agentRecordOf(spec: AgentSpec): WorkerRecord {
	return {
		id: spec.id,
		agentId: spec.id,
		sessionId: SESSION_ID,
		key: workerKey(SESSION_ID, spec.id),
		displayName: spec.description,
		status: spec.status,
		parentAgentId: spec.parentId,
		parentToolCallId: spec.parentToolCallId,
		kind: spec.agent,
		description: spec.description,
		progress: spec.progress,
		artifactAvailability: "available",
		sessionFile: subFile(spec.id),
		hasHistory: true,
		lastActivity: at(spec.endMin ?? 11.5),
		createdAt: at(spec.startMin ?? 11),
		adopted: false,
		revivable: false,
	};
}

/** Live subagent mirror entries (`state.subagents`) for the agent tree. */
export const agentTreeInfos: SubagentInfo[] = agentSpecs.map(agentInfoOf);

/** Roster records for the agent tree; they carry the parent links that nest the rows. */
export const agentTreeWorkers: WorkerRecord[] = agentSpecs.map(agentRecordOf);

/** Settings the tree row reads: the live tool preview and the resolved-model badge. */
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
						{
							path: "task.showResolvedModelBadge",
							label: "Resolved model badge",
							description: "Show the model a subagent resolved to.",
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
 * `display` also turns on the live-tool preview and model badge settings the tree row reads.
 */
export function seedAgentTree(options: { empty?: boolean; display?: boolean } = {}): void {
	const workers = options.empty === true ? [] : agentTreeWorkers;
	const infos = options.empty === true ? [] : agentTreeInfos;
	seedSubagents(
		{ workerList: () => workers },
		{
			currentSessionId: SESSION_ID,
			workers: workersStateOf(workers),
			subagents: subagentMapOf(infos),
			settingsModel: options.display === true ? agentSettingsModel : null,
		},
	);
}

/** One node of the seeded forest by agent id. Call after `seedAgentTree`. Throws on an unknown id. */
export function agentNode(id: string): SubagentNode {
	const found = flattenSubagentTree(subagentForest()).find((node) => node.id === id);
	if (found === undefined) throw new Error(`unknown agent node ${id}`);
	return found;
}
