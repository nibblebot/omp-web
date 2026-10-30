import type {
	Health,
	RawEntry,
	SessionStats,
	SessionSummary,
	StoredFileInfo,
	StoredSessionDetail,
	StoredSessionSummary,
	StoredWorkspaceSummary,
	SubagentFileInfo,
	SyncResult,
	TranscriptPage,
} from "#lib/wire/stats-types";
import { pairToolCalls, type PairingMaps } from "../../web/tx/components/transcript/pairing";

/**
 * Fixture data for the transcripts view: the /ctl/stats and /ctl/stored routes
 * (see routes.ts) and the tx stories. Typed against lib/wire/stats-types.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const START = Date.parse("2026-10-09T09:58:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Session files (paths are relative to the sessions dir, as the API returns them)
// ---------------------------------------------------------------------------

const FOLDER_WEB = "--home-joshua-Repos-omp-web--";
const FOLDER_FLEET = "--home-joshua-Repos-omp-fleet--";
const FOLDER_BENCH = "--home-joshua-Repos-pi-bench--";
const MAIN_STAMP = "2026-10-09T09-58-00-000Z_a1b2c3d4";

export const SESSION_FILE_MAIN = `${FOLDER_WEB}/${MAIN_STAMP}.jsonl`;
export const SESSION_FILE_SECOND = `${FOLDER_WEB}/2026-10-08T14-10-00-000Z_e5f6a7b8.jsonl`;
export const SESSION_FILE_UNSYNCED = `${FOLDER_FLEET}/2026-10-09T08-30-00-000Z_c9d0e1f2.jsonl`;
export const SESSION_FILE_STORE_ONLY = `${FOLDER_BENCH}/2026-09-30T10-00-00-000Z_0a1b2c3d.jsonl`;
/** A session whose JSONL cannot be read: stats, transcript and subagent routes fail for it. */
export const SESSION_FILE_BROKEN = `${FOLDER_WEB}/2026-10-09T11-02-00-000Z_broken00.jsonl`;
export const SUBAGENT_FILE_SCOUT = `${FOLDER_WEB}/${MAIN_STAMP}/0-DesignScout.jsonl`;
export const SUBAGENT_FILE_ADVISOR = `${FOLDER_WEB}/${MAIN_STAMP}/__advisor.jsonl`;

export const sessionSummaries: SessionSummary[] = [
	{
		file: SESSION_FILE_MAIN,
		folder: FOLDER_WEB,
		title: "DEMO: Build design system showcase",
		id: "a1b2c3d4",
		cwd: "/home/joshua/Repos/omp-web",
		firstTs: START,
		lastTs: START + 52 * MIN,
		turns: 14,
		toolCalls: 31,
		totalTokens: 482_113,
		totalCost: 2.37,
		errorTurns: 1,
		modelCount: 2,
		userMessages: 5,
		userChars: 1_204,
		synced: true,
		onDisk: true,
		size: 912_340,
		mtimeMs: START + 52 * MIN,
		stored: {
			workspaceId: "ws-omp-web",
			sessionId: "a1b2c3d4",
			mainRelpath: `${MAIN_STAMP}.jsonl`,
			readOnly: false,
			orphaned: false,
		},
	},
	{
		file: SESSION_FILE_SECOND,
		folder: FOLDER_WEB,
		title: "DEMO: Add retry policy for provider errors",
		id: "e5f6a7b8",
		cwd: "/home/joshua/Repos/omp-web",
		firstTs: START - 20 * HOUR,
		lastTs: START - 19 * HOUR,
		turns: 6,
		toolCalls: 9,
		totalTokens: 118_902,
		totalCost: 0.64,
		errorTurns: 0,
		modelCount: 1,
		userMessages: 2,
		userChars: 311,
		synced: true,
		onDisk: true,
		size: 204_118,
		mtimeMs: START - 19 * HOUR,
	},
	{
		file: SESSION_FILE_UNSYNCED,
		folder: FOLDER_FLEET,
		title: null,
		id: null,
		cwd: "/home/joshua/Repos/omp-fleet",
		firstTs: START - 90 * MIN,
		lastTs: START - 30 * MIN,
		turns: 0,
		toolCalls: 0,
		totalTokens: 0,
		totalCost: 0,
		errorTurns: 0,
		modelCount: 0,
		userMessages: 0,
		userChars: 0,
		synced: false,
		onDisk: true,
		size: 48_201,
		mtimeMs: START - 30 * MIN,
	},
	{
		file: SESSION_FILE_STORE_ONLY,
		folder: FOLDER_BENCH,
		title: "DEMO: Migrate fleet registry to atomic writes",
		id: "0a1b2c3d",
		cwd: null,
		firstTs: START - 9 * 24 * HOUR,
		lastTs: START - 9 * 24 * HOUR + HOUR,
		turns: 22,
		toolCalls: 40,
		totalTokens: 701_555,
		totalCost: 4.12,
		errorTurns: 2,
		modelCount: 3,
		userMessages: 8,
		userChars: 2_980,
		synced: true,
		onDisk: false,
		size: 1_450_000,
		mtimeMs: START - 9 * 24 * HOUR + HOUR,
		origin: "fleet-store",
		stored: {
			workspaceId: "ws-orphaned",
			sessionId: "0a1b2c3d",
			mainRelpath: "2026-09-30T10-00-00-000Z_0a1b2c3d.jsonl",
			readOnly: true,
			orphaned: true,
		},
	},
];

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export const sessionStats: SessionStats = {
	file: SESSION_FILE_MAIN,
	title: "DEMO: Build design system showcase",
	synced: true,
	spanMs: 52 * MIN,
	turns: 14,
	toolCalls: 31,
	tools: [
		{
			name: "read",
			calls: 12,
			errors: 0,
			pending: 0,
			totalMs: 1_840,
			avgMs: 153,
			maxMs: 410,
			argsChars: 960,
			resultChars: 61_200,
		},
		{
			name: "edit",
			calls: 8,
			errors: 1,
			pending: 0,
			totalMs: 2_240,
			avgMs: 280,
			maxMs: 902,
			argsChars: 14_300,
			resultChars: 3_100,
		},
		{
			name: "bash",
			calls: 7,
			errors: 1,
			pending: 0,
			totalMs: 98_500,
			avgMs: 14_071,
			maxMs: 61_020,
			argsChars: 1_050,
			resultChars: 22_400,
		},
		{
			name: "grep",
			calls: 4,
			errors: 0,
			pending: 0,
			totalMs: 520,
			avgMs: 130,
			maxMs: 211,
			argsChars: 330,
			resultChars: 8_800,
		},
	],
	longestCall: {
		toolName: "bash",
		toolCallId: "call_bash_typecheck",
		durationMs: 61_020,
		args: '{"command":"bun run check:types"}',
	},
	latency: { p50: 3_400, p90: 11_800 },
	totals: { tokens: 482_113, cost: 2.37 },
	errors: [
		{
			timestamp: START + 31 * MIN,
			model: "claude-sonnet-5-5",
			message: "overloaded_error: Overloaded",
		},
	],
	user: { count: 5, chars: 1_204 },
};

/** Stats for a session that is not in stats.db yet: live JSONL counts, empty DB columns. */
export const unsyncedSessionStats: SessionStats = {
	file: SESSION_FILE_UNSYNCED,
	title: null,
	synced: false,
	spanMs: 38 * MIN,
	turns: 0,
	toolCalls: 9,
	tools: [
		{
			name: "read",
			calls: 6,
			errors: 0,
			pending: 0,
			totalMs: 910,
			avgMs: 152,
			maxMs: 301,
			argsChars: 480,
			resultChars: 30_100,
		},
		{
			name: "bash",
			calls: 3,
			errors: 0,
			pending: 1,
			totalMs: 22_400,
			avgMs: 11_200,
			maxMs: 19_800,
			argsChars: 260,
			resultChars: 4_200,
		},
	],
	longestCall: {
		toolName: "bash",
		toolCallId: "call_bash_9",
		durationMs: 19_800,
		args: '{"command":"bun scripts/test.ts apps/fleet/test/registry.test.ts"}',
	},
	latency: { p50: null, p90: null },
	totals: { tokens: 0, cost: 0 },
	errors: [],
	user: { count: 3, chars: 540 },
};

/** Stats for a session with no tool calls and no error turns. */
export const quietSessionStats: SessionStats = {
	file: SESSION_FILE_SECOND,
	title: "DEMO: Add retry policy for provider errors",
	synced: true,
	spanMs: 64 * MIN,
	turns: 6,
	toolCalls: 0,
	tools: [],
	longestCall: null,
	latency: { p50: 2_100, p90: 4_700 },
	totals: { tokens: 118_902, cost: 0.64 },
	errors: [],
	user: { count: 2, chars: 311 },
};

/** Stats for one session file; null when the file cannot be read. */
export function statsFor(file: string): SessionStats | null {
	if (file === SESSION_FILE_BROKEN) return null;
	if (file === SESSION_FILE_SECOND) return quietSessionStats;
	if (file === SESSION_FILE_UNSYNCED) return unsyncedSessionStats;
	if (file === SUBAGENT_FILE_SCOUT) {
		return {
			...sessionStats,
			file,
			title: null,
			spanMs: 4 * MIN,
			turns: 3,
			toolCalls: 6,
			tools: sessionStats.tools.filter((t) => t.name === "read" || t.name === "grep"),
			longestCall: null,
			errors: [],
			user: { count: 1, chars: 412 },
		};
	}
	return { ...sessionStats, file };
}

export const subagentFiles: SubagentFileInfo[] = [
	{
		file: SUBAGENT_FILE_SCOUT,
		name: "0-DesignScout.jsonl",
		size: 88_410,
		mtimeMs: START + 20 * MIN,
	},
	{
		file: SUBAGENT_FILE_ADVISOR,
		name: "__advisor.jsonl",
		size: 12_904,
		mtimeMs: START + 40 * MIN,
	},
];

/** Subagent list for one session file; null when it cannot be read. */
export function subagentsFor(file: string): SubagentFileInfo[] | null {
	if (file === SESSION_FILE_BROKEN) return null;
	if (file === SESSION_FILE_MAIN) return subagentFiles;
	return [];
}

export const health: Health = {
	ok: true,
	statsDb: "ok",
	statsDbPath: "/home/joshua/.omp/stats.db",
	statsDbFromCopy: false,
	isolated: false,
	lastSyncedAt: "2026-10-16T14:02:00.000Z",
	syncing: false,
	sessionsDir: "/home/joshua/.omp/agent/sessions",
	sessionsCount: 4,
	dbCounts: { messages: 1_204, toolCalls: 311, userMessages: 87 },
	fleetStore: { workspaces: 3, sessions: 4, bytes: 5_890_270 },
};

/** Health with the stats DB missing: warn banner, no store line. */
export const healthMissingDb: Health = {
	ok: false,
	statsDb: "missing",
	statsDbPath: "/home/joshua/.omp/stats.db",
	statsDbFromCopy: false,
	isolated: false,
	lastSyncedAt: null,
	syncing: false,
	sessionsDir: "/home/joshua/.omp/agent/sessions",
	sessionsCount: 214,
	dbCounts: null,
};

/** Health with an unreadable stats DB: error banner. */
export const healthErrorDb: Health = {
	ok: false,
	statsDb: "error",
	statsDbPath: "/home/joshua/.omp/stats.db",
	statsDbFromCopy: true,
	isolated: false,
	lastSyncedAt: null,
	syncing: false,
	sessionsDir: "/home/joshua/.omp/agent/sessions",
	sessionsCount: 214,
	dbCounts: null,
};

export const syncResult: SyncResult = {
	processed: 3,
	files: 4,
	totalMessages: 1_204,
	durationMs: 842,
};

// ---------------------------------------------------------------------------
// Transcript entries (raw JSONL lines), one named fixture per entry kind
// ---------------------------------------------------------------------------

const text = (t: string): RawEntry => ({ type: "text", text: t });

const assistantUsage = (input: number, output: number, cacheRead: number, cost: number) => ({
	input,
	output,
	cacheRead,
	cacheWrite: 0,
	totalTokens: input + output + cacheRead,
	premiumRequests: 0,
	cost: {
		input: cost * 0.4,
		output: cost * 0.4,
		cacheRead: cost * 0.2,
		cacheWrite: 0,
		total: cost,
	},
});

function message(id: string, parentId: string | null, at: number, body: RawEntry): RawEntry {
	return { type: "message", id, parentId, timestamp: iso(at), message: body };
}

function assistant(
	id: string,
	parentId: string,
	at: number,
	content: RawEntry[],
	extra: RawEntry = {},
): RawEntry {
	return message(id, parentId, at, {
		role: "assistant",
		content,
		model: "claude-sonnet-5-5",
		provider: "anthropic",
		api: "anthropic-messages",
		usage: assistantUsage(3_210, 412, 18_400, 0.0213),
		duration: 4_800,
		ttft: 920,
		stopReason: "stop",
		timestamp: at,
		...extra,
	});
}

function toolResult(
	id: string,
	parentId: string,
	at: number,
	toolCallId: string,
	toolName: string,
	output: string,
	extra: RawEntry = {},
): RawEntry {
	return message(id, parentId, at, {
		role: "toolResult",
		toolCallId,
		toolName,
		isError: false,
		content: [text(output)],
		timestamp: at,
		...extra,
	});
}

function executionStart(id: string, parentId: string, at: number, toolCallId: string): RawEntry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: iso(at),
		customType: "tool_execution_start",
		data: { toolCallId, startedAt: iso(at) },
	};
}

const T = (seconds: number): number => START + seconds * 1000;

export const sessionHeaderEntry: RawEntry = {
	type: "session",
	id: "a1b2c3d4",
	version: 3,
	timestamp: iso(T(0)),
	cwd: "/home/joshua/Repos/omp-web",
	title: "DEMO: Build design system showcase",
	titleSource: "auto",
};

export const sessionInitEntry: RawEntry = {
	type: "session_init",
	id: "e0000001",
	parentId: null,
	timestamp: iso(T(1)),
	systemPrompt: [
		"You are Claude Code, Anthropic's official CLI for Claude.\n\nRFC 2119 keywords: MUST, SHOULD, NEVER.",
		"## Engineering\n- Correctness, then six-month maintainability.\n- Prefer boring design to needless abstraction.\n- NEVER use `sed` or `perl` via bash to issue individual edits.",
		"## Workspace\nRepository: omp-web. Bun, TypeScript ESM, Solid.js. Tabs, `import type`, no em dashes in prose.",
	],
	tools: ["read", "edit", "write", "bash", "grep", "glob", "task", "todo_write", "web_search"],
	resolvedModel: "anthropic/claude-sonnet-5-5",
	modelRole: "default",
	agent: null,
	task: null,
	spawns: "*",
	outputSchema: null,
	outputSchemaMode: null,
	readOnly: false,
	readSummarize: true,
};

/** A subagent's session_init: task text, agent name, read-only tools and an output schema. */
export const subagentInitEntry: RawEntry = {
	type: "session_init",
	id: "s0000001",
	parentId: null,
	timestamp: iso(T(740)),
	systemPrompt: [
		"You are a read-only scout. Investigate the codebase and return compressed context. NEVER edit files.",
	],
	tools: ["read", "grep", "glob"],
	resolvedModel: "anthropic/claude-haiku-5-5",
	modelRole: "scout",
	agent: "DesignScout",
	task: "Map every component under apps/web/components/ui and report which ones import from state.ts.\n\nReturn a table: component, file, store imports.",
	spawns: "",
	outputSchema: {
		type: "object",
		properties: {
			components: {
				type: "array",
				items: {
					type: "object",
					properties: { name: { type: "string" }, file: { type: "string" } },
					required: ["name", "file"],
				},
			},
		},
		required: ["components"],
	},
	outputSchemaMode: "strict",
	readOnly: true,
	readSummarize: false,
};

export const modelChangeEntry: RawEntry = {
	type: "model_change",
	id: "e0000002",
	parentId: "e0000001",
	timestamp: iso(T(2)),
	model: "anthropic/claude-sonnet-5-5",
	role: "default",
};

export const thinkingLevelChangeEntry: RawEntry = {
	type: "thinking_level_change",
	id: "e0000003",
	parentId: "e0000002",
	timestamp: iso(T(2)),
	thinkingLevel: "high",
	configured: "high",
};

export const serviceTierChangeEntry: RawEntry = {
	type: "service_tier_change",
	id: "e0000004",
	parentId: "e0000003",
	timestamp: iso(T(2)),
	serviceTier: null,
};

export const modeChangeEntry: RawEntry = {
	type: "mode_change",
	id: "e0000005",
	parentId: "e0000004",
	timestamp: iso(T(3)),
	mode: "plan",
	data: {
		planFilePath: "local://DESIGN_SYSTEM_PLAN.md",
		reason: "user-requested",
		interactive: true,
		allowedTools: ["read", "grep", "glob", "ask"],
	},
};

export const userEntry: RawEntry = message("e0000006", "e0000005", T(5), {
	role: "user",
	content: [
		text(
			"Add stories for the shared components to the design-system showcase. Start with `CopyButton` and `DiffToolCard`, and type every fixture against the real exported types.",
		),
	],
	attribution: "user",
	timestamp: T(5),
});

export const userImageEntry: RawEntry = message("e0000040", "e0000006", T(2_900), {
	role: "user",
	content: [
		text("The status bar looks wrong in the light theme, see the screenshot:"),
		{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
	],
	attribution: "user",
	steering: true,
	timestamp: T(2_900),
});

export const developerEntry: RawEntry = message("e0000007", "e0000006", T(6), {
	role: "developer",
	content: [
		text(
			"<system-reminder>\nPlan mode is active. You MUST NOT edit files outside `local://`.\n\n- Use `read` and `grep` to explore.\n- End the plan with a `yield` call.\n</system-reminder>",
		),
	],
	timestamp: T(6),
});

export const fileMentionEntry: RawEntry = message("e0000008", "e0000007", T(7), {
	role: "fileMention",
	files: [
		{
			path: "apps/design-system/registry.ts",
			content:
				"export interface Story {\n\t/** URL-safe unique id, used as the hash route (`#/<id>`). */\n\tid: string;\n\ttitle: string;\n\tcomponent: ComponentRef;\n\tvariants: StoryVariant[];\n}\n\nexport function defineStory(story: Story): Story {\n\treturn story;\n}\n",
		},
		{
			path: "apps/web/components/ui/CopyButton.tsx",
			content:
				"export const COPY_FEEDBACK_MS = 1200;\n\nexport const CopyButton = (props: { text: string; label?: string }) => {\n\t// ...\n};\n",
		},
	],
	timestamp: T(7),
});

const readCall = assistant(
	"e0000009",
	"e0000008",
	T(12),
	[
		{
			type: "thinking",
			thinking:
				"I should read the CopyButton source first, then the story registry, so the fixtures match the real props.",
		},
		text("I'll start by reading the component and its tests."),
		{
			type: "toolCall",
			id: "call_read_1",
			name: "read",
			arguments: { path: "apps/web/components/ui/CopyButton.tsx" },
		},
	],
	{ stopReason: "toolUse" },
);

export const toolResultEntry: RawEntry = toolResult(
	"e0000011",
	"e0000009",
	T(13),
	"call_read_1",
	"read",
	"1\texport const COPY_FEEDBACK_MS = 1200;\n2\t\n3\texport const CopyButton = (props: CopyButtonProps) => {\n4\t\tconst [copied, setCopied] = createSignal(false);\n5\t\t// ...\n6\t};",
	{ details: { path: "apps/web/components/ui/CopyButton.tsx", lines: 6, truncated: false } },
);

/** Tool result whose call was not loaded in the same page: ToolResultRow renders it standalone. */
export const bashErrorResultEntry: RawEntry = toolResult(
	"e0000015",
	"e0000014",
	T(122),
	"call_bash_typecheck",
	"bash",
	"$ bun run check:types\napps/design-system/stories/diff-tool.tsx(14,9): error TS2322: Type 'number' is not assignable to type 'string'.\napps/design-system/fixtures/tools.ts(31,3): error TS2741: Property 'status' is missing in type '{ id: string; }' but required in type 'ToolItem'.\n\nFound 2 errors in 2 files.\nexit code 1",
	{
		isError: true,
		details: { exitCode: 1, durationMs: 61_020 },
	},
);

const longBashOutput = Array.from({ length: 48 }, (_, i) => {
	const n = String(i + 1).padStart(2, "0");
	return `apps/web/test/tool-card-${n}.test.ts: ok (${(12 + i * 3) % 90} ms)`;
}).join("\n");

export const longToolResultEntry: RawEntry = toolResult(
	"e0000030",
	"e0000029",
	T(1_410),
	"call_bash_tests",
	"bash",
	`$ bun scripts/test.ts apps/web\n${longBashOutput}\n\n48 passed, 0 failed (3.1 s)`,
	{ details: { exitCode: 0, durationMs: 3_120 }, useless: false },
);

export const prunedToolResultEntry: RawEntry = toolResult(
	"e0000031",
	"e0000030",
	T(1_420),
	"call_read_old",
	"read",
	"[output pruned to save context]",
	{ useless: true, prunedAt: iso(T(1_500)) },
);

export const assistantEntry: RawEntry = readCall;

/** Assistant turn with prose, a fenced code block, a tool call with a result, and usage details. */
export const assistantRichEntry: RawEntry = assistant(
	"e0000020",
	"e0000019",
	T(600),
	[
		{
			type: "thinking",
			thinking:
				"The registry expects `defineStory` with `component.file` and `component.export`. Fixtures must be typed with `satisfies`.",
		},
		text(
			'The story file registers the real component and a few variants:\n\n```tsx\nexport default defineStory({\n\tid: "copy-button",\n\ttitle: "CopyButton",\n\tcomponent: { file: "apps/web/components/ui/CopyButton.tsx", export: "CopyButton" },\n\tvariants: [{ name: "Default", render: () => <CopyButton text="bun run check:types" /> }],\n});\n```\n\nNext I\'ll write it and run the type check.',
		),
		{
			type: "toolCall",
			id: "call_write_1",
			name: "write",
			arguments: {
				path: "apps/design-system/stories/copy-button.tsx",
				content: 'export default defineStory({ id: "copy-button" });\n',
			},
		},
	],
	{
		stopReason: "toolUse",
		contextSnapshot: { promptTokens: 21_610, nonMessageTokens: 6_900 },
		usage: { ...assistantUsage(3_210, 1_086, 18_400, 0.0384), reasoningTokens: 640 },
		duration: 11_400,
	},
);

/** Assistant turn that failed with a provider error. */
export const assistantErrorEntry: RawEntry = assistant("e0000024", "e0000023", T(1_870), [], {
	stopReason: "error",
	errorMessage: "overloaded_error: Overloaded",
	errorStatus: 529,
	errorId: "req_011CUnkd9F2xQe",
	usage: assistantUsage(0, 0, 0, 0),
	duration: 31_000,
	ttft: null,
});

/** Assistant turn with a call that has an execution-start marker but no result yet. */
export const assistantPendingEntry: RawEntry = assistant(
	"e0000050",
	"e0000049",
	T(3_100),
	[
		text("Running the full test suite now."),
		{
			type: "toolCall",
			id: "call_bash_pending",
			name: "bash",
			arguments: { command: "bun run test", timeout: 600 },
		},
	],
	{ stopReason: "toolUse" },
);

export const pendingStartEntry: RawEntry = executionStart(
	"e0000051",
	"e0000050",
	T(3_101),
	"call_bash_pending",
);

export const finalAssistantEntry: RawEntry = assistant(
	"e0000028",
	"e0000027",
	T(2_480),
	[
		text(
			"Both stories are in place and the registry picks them up automatically.\n\n- `stories/copy-button.tsx`: default, long text, custom label\n- `stories/diff-tool.tsx`: edit, write, running, malformed args\n\n`bun run check:types` is clean.",
		),
	],
	{ usage: assistantUsage(3_890, 188, 22_100, 0.0178), duration: 3_900, ttft: 740 },
);

export const ttsrInjectionEntry: RawEntry = {
	type: "ttsr_injection",
	id: "e0000021",
	parentId: "e0000020",
	timestamp: iso(T(660)),
	injectedRules: ["no-em-dash-in-prose", "tabs-not-spaces", "import-type-for-types"],
};

export const compactionEntry: RawEntry = {
	type: "compaction",
	id: "e0000025",
	parentId: "e0000024",
	timestamp: iso(T(1_900)),
	firstKeptEntryId: "e0000019",
	tokensBefore: 168_204,
	summary:
		"## Goal\nAdd stories for every shared component in the design-system showcase.\n\n## Done\n- Read `registry.ts`, `stage.tsx` and the `CopyButton` source.\n- Wrote `stories/copy-button.tsx` and `stories/diff-tool.tsx`.\n- Fixtures live in `apps/design-system/fixtures/tools.ts`, typed with `satisfies`.\n\n## Open\n- Type check reported two errors in `diff-tool.tsx` and `tools.ts`; both fixed.\n- Remaining: `Toasts`, `StatusBar`, `Modal`.\n\n## Conventions\nTabs, `import type`, no em dashes, no inline styles.",
};

export const titleChangeEntry: RawEntry = {
	type: "title_change",
	id: "e0000026",
	parentId: "e0000025",
	timestamp: iso(T(1_905)),
	previousTitle: "Add stories for the shared components",
	title: "DEMO: Build design system showcase",
	source: "auto",
	trigger: "compaction",
};

export const labelEntry: RawEntry = {
	type: "label",
	id: "e0000041",
	parentId: "e0000028",
	timestamp: iso(T(2_500)),
	targetId: "e0000028",
	label: "stories landed",
};

export const customMessageEntry: RawEntry = {
	type: "custom_message",
	id: "e0000022",
	parentId: "e0000021",
	timestamp: iso(T(700)),
	customType: "review-notes",
	display: true,
	content:
		"### Review notes\n\nThe pass found **three** items worth fixing before the stories land:\n\n1. `fixtures/tools.ts` casts with `as unknown as`.\n2. `diff-tool.tsx` renders the diff inside a fixed-height container.\n3. The running variant has no timestamp.",
	details: {
		notes: [
			{ note: "fixtures/tools.ts:31 uses a type assertion", severity: "error" },
			{ note: "diff-tool.tsx long diffs overflow the frame", severity: "warn" },
			{ note: "running variant now shows elapsed time", severity: "info" },
			{ note: "consider a story per tool kind", severity: "idea" },
		],
	},
};

/** A hidden custom message (display: false) with no markdown body. */
export const customMessageHiddenEntry: RawEntry = {
	type: "custom_message",
	id: "e0000042",
	parentId: "e0000022",
	timestamp: iso(T(705)),
	customType: "skill-context",
	display: false,
	content: "",
	details: { notes: [] },
};

export const customDataEntry: RawEntry = {
	type: "custom",
	id: "e0000043",
	parentId: "e0000022",
	timestamp: iso(T(710)),
	customType: "plan-approved",
	data: {
		planFilePath: "local://DESIGN_SYSTEM_PLAN.md",
		approvedAt: iso(T(710)),
		steps: [
			{ id: 1, title: "Read registry and stage contract", done: true },
			{ id: 2, title: "Write story files", done: false },
		],
	},
};

export const goalCompletedEntry: RawEntry = {
	type: "custom",
	id: "e0000044",
	parentId: "e0000028",
	timestamp: iso(T(2_490)),
	customType: "goal-completed",
	data: {
		objective: "Add typed stories for CopyButton and DiffToolCard to the design-system showcase",
		timeUsedSeconds: 2_480,
		tokensUsed: 482_113,
	},
};

export const sessionExitEntry: RawEntry = {
	type: "custom",
	id: "e0000045",
	parentId: "e0000044",
	timestamp: iso(T(2_500)),
	customType: "session_exit",
	data: { kind: "clean", reason: "user-quit", recordedAt: iso(T(2_500)) },
};

/** A `custom` entry with no recognizable payload: renders the generic row. */
export const customUnknownEntry: RawEntry = {
	type: "custom",
	id: "e0000046",
	timestamp: iso(T(2_501)),
};

export const credentialPinEntry: RawEntry = {
	type: "credential_pin",
	id: "e0000047",
	parentId: "e0000046",
	timestamp: iso(T(2_502)),
	provider: "anthropic",
	credentialId: "cred_work_01",
};

export const unknownTypeEntry: RawEntry = {
	type: "branch_summary",
	id: "e0000048",
	parentId: "e0000046",
	timestamp: iso(T(2_503)),
	summary: "Explored a Storybook-style layout, abandoned in favour of the hash-routed showcase.",
};

export const editCallEntry: RawEntry = assistant(
	"e0000012",
	"e0000011",
	T(40),
	[
		text("Now the story file."),
		{
			type: "toolCall",
			id: "call_edit_1",
			name: "edit",
			arguments: {
				path: "apps/design-system/stories/diff-tool.tsx",
				edits: [{ oldText: 'id: "diff"', newText: 'id: "diff-tool"' }],
			},
		},
	],
	{ stopReason: "toolUse" },
);

const bashCall = assistant(
	"e0000014",
	"e0000013",
	T(61),
	[
		{
			type: "toolCall",
			id: "call_bash_typecheck",
			name: "bash",
			arguments: { command: "bun run check:types" },
		},
	],
	{ stopReason: "toolUse" },
);

/** Main-session transcript, in file order. Every tool call is paired with its result. */
export const transcriptEntries: RawEntry[] = [
	sessionHeaderEntry,
	sessionInitEntry,
	modelChangeEntry,
	thinkingLevelChangeEntry,
	serviceTierChangeEntry,
	modeChangeEntry,
	userEntry,
	developerEntry,
	fileMentionEntry,
	readCall,
	executionStart("e0000010", "e0000009", T(12), "call_read_1"),
	toolResultEntry,
	editCallEntry,
	executionStart("e0000013", "e0000012", T(41), "call_edit_1"),
	toolResult(
		"e0000052",
		"e0000012",
		T(42),
		"call_edit_1",
		"edit",
		"Updated apps/design-system/stories/diff-tool.tsx (+1 -1)",
		{ details: { path: "apps/design-system/stories/diff-tool.tsx", added: 1, removed: 1 } },
	),
	bashCall,
	executionStart("e0000053", "e0000014", T(61), "call_bash_typecheck"),
	bashErrorResultEntry,
	assistantRichEntry,
	ttsrInjectionEntry,
	customMessageEntry,
	customDataEntry,
	toolResult(
		"e0000054",
		"e0000020",
		T(605),
		"call_write_1",
		"write",
		"Wrote 1 line to apps/design-system/stories/copy-button.tsx",
		{ details: { path: "apps/design-system/stories/copy-button.tsx", lines: 1 } },
	),
	assistantErrorEntry,
	compactionEntry,
	titleChangeEntry,
	finalAssistantEntry,
	labelEntry,
	goalCompletedEntry,
	sessionExitEntry,
];

/** Entries covering the remaining kinds, for the generic-row and edge-case stories. */
export const extraEntries: RawEntry[] = [
	credentialPinEntry,
	unknownTypeEntry,
	customUnknownEntry,
	customMessageHiddenEntry,
	userImageEntry,
	prunedToolResultEntry,
	longToolResultEntry,
	assistantPendingEntry,
	pendingStartEntry,
];

/** Subagent (DesignScout) transcript. */
export const subagentEntries: RawEntry[] = [
	{
		type: "session",
		id: "s0000000",
		version: 3,
		timestamp: iso(T(740)),
		cwd: "/home/joshua/Repos/omp-web",
		title: "DesignScout",
		titleSource: "auto",
	},
	subagentInitEntry,
	message("s0000002", "s0000001", T(742), {
		role: "user",
		content: [
			text(
				"Map every component under apps/web/components/ui and report which ones import from state.ts.",
			),
		],
		attribution: "agent",
		timestamp: T(742),
	}),
	assistant(
		"s0000003",
		"s0000002",
		T(748),
		[
			text("Listing the shared components first."),
			{
				type: "toolCall",
				id: "call_scout_grep",
				name: "grep",
				arguments: { pattern: 'from "../../state"', path: "apps/web/components/ui" },
			},
		],
		{
			stopReason: "toolUse",
			model: "claude-haiku-5-5",
			usage: assistantUsage(1_200, 96, 0, 0.0021),
		},
	),
	executionStart("s0000004", "s0000003", T(749), "call_scout_grep"),
	toolResult(
		"s0000005",
		"s0000003",
		T(750),
		"call_scout_grep",
		"grep",
		'apps/web/components/app/ViewSwitch.tsx:3:import { setView, state } from "../../state";\napps/web/components/ui/Toasts.tsx:2:import { dismissToast, state } from "../../state";',
		{ details: { matches: 2, files: 2 } },
	),
	assistant(
		"s0000006",
		"s0000005",
		T(790),
		[
			text(
				"Two shared components read the store: `ViewSwitch` and `Toasts`. Every other component under `shared/` is props-only.",
			),
		],
		{ model: "claude-haiku-5-5", usage: assistantUsage(1_540, 142, 0, 0.0027), duration: 2_100 },
	),
];

/** Advisor transcript: a short second-opinion exchange. */
export const advisorEntries: RawEntry[] = [
	{
		type: "session",
		id: "ad000000",
		version: 3,
		timestamp: iso(T(1_300)),
		cwd: "/home/joshua/Repos/omp-web",
		title: "advisor",
		titleSource: "auto",
	},
	message("ad000001", null, T(1_302), {
		role: "user",
		content: [text("Is replacing `as unknown as` with `satisfies` enough for the tool fixtures?")],
		attribution: "agent",
		timestamp: T(1_302),
	}),
	assistant(
		"ad000002",
		"ad000001",
		T(1_309),
		[
			text(
				"Yes, as long as the object literal is complete. Where a field is optional on the real type, leave it out instead of casting.",
			),
		],
		{ usage: assistantUsage(900, 74, 0, 0.0031) },
	),
];

/** PairingMaps for the main transcript, as the real `pairToolCalls` produces them. */
export const transcriptPairing: PairingMaps = pairToolCalls([
	...transcriptEntries,
	...extraEntries,
]);

/** PairingMaps with no calls: for rows that need none. */
export const emptyPairing: PairingMaps = pairToolCalls([]);

/** Entries for one session or subagent file. */
export function entriesFor(file: string): RawEntry[] {
	if (file.endsWith("__advisor.jsonl")) return advisorEntries;
	if (file.includes("DesignScout")) return subagentEntries;
	return transcriptEntries;
}

export const transcriptPage = (
	offset: number,
	limit: number,
	entries: RawEntry[] = transcriptEntries,
): TranscriptPage => {
	const slice = entries.slice(offset, offset + limit);
	const next = offset + slice.length;
	return {
		entries: slice,
		nextOffset: next < entries.length ? next : null,
		offset,
		limit,
		totalLines: entries.length,
		truncated: false,
	};
};

export const rawTranscript = (entries: RawEntry[] = transcriptEntries): string =>
	entries.map((e) => JSON.stringify(e)).join("\n");

// ---------------------------------------------------------------------------
// Fleet log store (/ctl/stored)
// ---------------------------------------------------------------------------

export const storedWorkspaces: StoredWorkspaceSummary[] = [
	{
		workspaceId: "ws-omp-web",
		sessions: 2,
		bytes: 1_116_458,
		readOnly: false,
		orphaned: false,
		viewOnly: false,
		provenance: { projectId: "proj-1", kind: "worktree", branch: "design-system" },
	},
	{
		workspaceId: "ws-orphaned",
		sessions: 1,
		bytes: 1_450_000,
		readOnly: true,
		orphaned: true,
		viewOnly: true,
		provenance: {
			projectId: "proj-2",
			kind: "clone",
			profileId: "github-readonly",
			branch: "main",
			pinnedRevision: "9f2c1ab",
			sourceKind: "remote",
		},
	},
	{
		workspaceId: "ws-bench-old",
		sessions: 1,
		bytes: 3_323_812,
		readOnly: true,
		orphaned: true,
		viewOnly: true,
		provenance: {
			projectId: "proj-3",
			kind: "clone",
			branch: "perf/harness",
			pinnedRevision: "41d07e2",
			sourceKind: "local",
		},
	},
];

const OLD_STAMP = "2026-09-30T10-00-00-000Z_0a1b2c3d";
const RETRY_STAMP = "2026-10-08T14-10-00-000Z_e5f6a7b8";
const BENCH_STAMP = "2026-09-22T16-20-00-000Z_7c8d9e0f";

export const storedSessions: StoredSessionSummary[] = [
	{
		workspaceId: "ws-omp-web",
		sessionId: "a1b2c3d4",
		title: "DEMO: Build design system showcase",
		cwd: "/home/joshua/Repos/omp-web",
		firstTs: START,
		lastTs: START + 52 * MIN,
		bytes: 912_340,
		fileCount: 3,
		kinds: { main: 1, subagent: 1, advisor: 1, metadata: 0 },
		mainRelpath: `${MAIN_STAMP}.jsonl`,
		readOnly: false,
		orphaned: false,
		missingAssets: 0,
		provenance: { projectId: "proj-1", kind: "worktree", branch: "design-system" },
	},
	{
		workspaceId: "ws-omp-web",
		sessionId: "e5f6a7b8",
		title: "DEMO: Add retry policy for provider errors",
		cwd: "/home/joshua/Repos/omp-web",
		firstTs: START - 20 * HOUR,
		lastTs: START - 19 * HOUR,
		bytes: 204_118,
		fileCount: 2,
		kinds: { main: 1, subagent: 1, advisor: 0, metadata: 0 },
		mainRelpath: `${RETRY_STAMP}.jsonl`,
		readOnly: false,
		orphaned: false,
		missingAssets: 1,
		provenance: { projectId: "proj-1", kind: "worktree", branch: "design-system" },
	},
	{
		workspaceId: "ws-orphaned",
		sessionId: "0a1b2c3d",
		title: "DEMO: Migrate fleet registry to atomic writes",
		cwd: null,
		firstTs: START - 9 * 24 * HOUR,
		lastTs: START - 9 * 24 * HOUR + HOUR,
		bytes: 1_450_000,
		fileCount: 2,
		kinds: { main: 1, subagent: 1, advisor: 0, metadata: 0 },
		mainRelpath: `${OLD_STAMP}.jsonl`,
		readOnly: true,
		orphaned: true,
		missingAssets: 0,
		provenance: {
			projectId: "proj-2",
			kind: "clone",
			profileId: "github-readonly",
			branch: "main",
			pinnedRevision: "9f2c1ab",
			sourceKind: "remote",
		},
	},
	{
		workspaceId: "ws-bench-old",
		sessionId: "7c8d9e0f",
		title: "Benchmark harness cleanup",
		cwd: null,
		firstTs: START - 17 * 24 * HOUR,
		lastTs: START - 17 * 24 * HOUR + 2 * HOUR,
		bytes: 3_323_812,
		fileCount: 1,
		kinds: { main: 1, subagent: 0, advisor: 0, metadata: 0 },
		mainRelpath: `${BENCH_STAMP}.jsonl`,
		readOnly: true,
		orphaned: true,
		missingAssets: 0,
		provenance: {
			projectId: "proj-3",
			kind: "clone",
			branch: "perf/harness",
			pinnedRevision: "41d07e2",
			sourceKind: "local",
		},
	},
];

function storedFilesFor(summary: StoredSessionSummary): StoredFileInfo[] {
	const main = summary.mainRelpath ?? `${summary.sessionId}.jsonl`;
	const dir = main.replace(/\.jsonl$/, "");
	const files: StoredFileInfo[] = [
		{
			relpath: main,
			kind: "main",
			bytes: summary.bytes,
			ackedBytes: summary.bytes,
			eof: true,
			status: "stored",
		},
	];
	if (summary.kinds.subagent > 0) {
		const missing = summary.missingAssets > 0;
		files.push({
			relpath: `${dir}/0-DesignScout.jsonl`,
			kind: "subagent",
			parentPath: main,
			bytes: missing ? 0 : 88_410,
			ackedBytes: 88_410,
			eof: !missing,
			status: missing ? "missing" : "stored",
		});
	}
	if (summary.kinds.advisor > 0) {
		files.push({
			relpath: `${dir}/__advisor.jsonl`,
			kind: "advisor",
			parentPath: main,
			bytes: 12_904,
			ackedBytes: 12_904,
			eof: true,
			status: "stored",
		});
	}
	return files;
}

export function storedSessionDetail(
	workspaceId: string,
	sessionId: string,
): StoredSessionDetail | null {
	const summary = storedSessions.find(
		(s) => s.workspaceId === workspaceId && s.sessionId === sessionId,
	);
	return summary ? { ...summary, files: storedFilesFor(summary) } : null;
}
