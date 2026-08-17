/**
 * Regenerates the transcripts/stats test fixture (idempotent) for the
 * fleet/stats API tests in test/.
 *
 * Layout produced:
 *   test/.fixture/stats.db
 *   test/.fixture/agent/sessions/
 *     proj-a/2026-01-01T10-00-00-000Z_aaaa.jsonl          main session (parallel calls,
 *                                                         error turn, pending call, garbage tail)
 *     proj-a/2026-01-01T10-00-00-000Z_aaaa.jsonl/
 *       SubOne.jsonl                                      subagent transcript
 *       __advisor.jsonl                                   advisor transcript
 *     proj-b/2026-01-02T10-00-00-000Z_bbbb.jsonl          main session, normal
 *     proj-c/2026-01-03T10-00-00-000Z_cccc.jsonl          main session, NO stats.db rows (unsynced)
 *     proj-d/2026-01-04T10-00-00-000Z_dddd.jsonl          DB rows only — file NOT on disk
 *
 * Real-world quirks mirrored:
 *   - stats.db tables match the real schema; session_file stored as ABSOLUTE paths
 *     (real omp writes absolute paths) EXCEPT proj-d's rows, which are stored
 *     RELATIVE to cover the schema-comment case (normDbFile accepts both).
 *   - subagent transcripts live in a directory named after the main session file.
 *   - proj-a ends with a truncated/corrupt trailing line (lenient parsing).
 *
 * The script is side-effect free on import: everything (including the EXPECT
 * numbers used by test/api.test.ts) is derived from the same literals, so the
 * tests can never drift from the fixture. Running it (`bun scripts/gen-tx-fixture.ts`)
 * deletes and recreates test/.fixture/.
 */
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const FIXTURE_ROOT = join(import.meta.dir, "..", "test", ".fixture");
export const SESSIONS_DIR = join(FIXTURE_ROOT, "agent", "sessions");
export const STATS_DB_PATH = join(FIXTURE_ROOT, "stats.db");

const MODEL = "claude-sonnet-4";
const PROVIDER = "anthropic";
const API = "anthropic";
const FOLDER_A = "proj-a";
const FOLDER_B = "proj-b";
const FOLDER_C = "proj-c";
const FOLDER_D = "proj-d";

// ---------------------------------------------------------------------------
// Row shapes (mirror the real schema — see PLAN.md §2.1)
// ---------------------------------------------------------------------------

interface MsgRow {
	session_file: string;
	entry_id: string;
	folder: string;
	model: string;
	provider: string;
	api: string;
	timestamp: number;
	duration: number | null;
	ttft: number | null;
	stop_reason: string;
	error_message: string | null;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	total_tokens: number;
	premium_requests: number;
	cost_input: number;
	cost_output: number;
	cost_cache_read: number;
	cost_cache_write: number;
	cost_total: number;
	agent_type: string;
}

interface ToolRow {
	session_file: string;
	entry_id: string;
	tool_call_id: string;
	folder: string;
	tool_name: string;
	model: string;
	provider: string;
	timestamp: number;
	agent_type: string;
	calls_in_turn: number;
	args_chars: number;
	result_chars: number | null;
	is_error: number | null;
}

interface UserRow {
	session_file: string;
	entry_id: string;
	folder: string;
	timestamp: number;
	model: string;
	provider: string;
	chars: number;
	words: number;
	yelling: number;
	profanity: number;
	anguish: number;
	negation: number;
	repetition: number;
	blame: number;
}

// ---------------------------------------------------------------------------
// JSONL builders
// ---------------------------------------------------------------------------

function titleSlot(title: string, updatedAt: string): string {
	// Real omp keeps a fixed-width (256 B) mutable title slot.
	const base = { type: "title", v: 1, title, source: "auto", updatedAt };
	const empty = JSON.stringify({ ...base, pad: "" });
	const pad = " ".repeat(Math.max(0, 256 - empty.length));
	return JSON.stringify({ ...base, pad });
}

function sessionHeader(id: string, title: string | null, iso: string, cwd: string): string {
	const o: Record<string, unknown> = { type: "session", id, version: 1, timestamp: iso, cwd };
	if (title !== null) o.title = title;
	return JSON.stringify(o);
}

function sysLine(
	type: string,
	id: string,
	iso: string,
	extra: Record<string, unknown> = {},
): string {
	return JSON.stringify({ type, id, parentId: null, timestamp: iso, ...extra });
}

function userLine(entryId: string, iso: string, content: string): string {
	return JSON.stringify({
		type: "message",
		id: entryId,
		parentId: null,
		timestamp: iso,
		message: { role: "user", content: [{ type: "text", text: content }] },
	});
}

interface Turn {
	entryId: string;
	iso: string;
	blocks: Record<string, unknown>[];
	duration: number;
	ttft: number;
	stopReason: string;
	errorMessage?: string;
	errorId?: string;
	errorStatus?: number;
	responseId?: string;
	stopDetails?: Record<string, unknown>;
	contextSnapshot?: { promptTokens: number; nonMessageTokens: number };
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
		premium: number;
		reasoningTokens?: number;
	};
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

const text = (t: string): Record<string, unknown> => ({ type: "text", text: t });
const toolCall = (
	id: string,
	name: string,
	args: Record<string, unknown>,
): Record<string, unknown> => ({
	type: "toolCall",
	id,
	name,
	arguments: args,
});

function assistantLine(
	turn: Turn,
	sessionFile: string,
	folder: string,
): { line: string; msgRow: MsgRow; toolRows: ToolRow[] } {
	const ts = Date.parse(turn.iso);
	const toolBlocks = turn.blocks.filter((b) => b.type === "toolCall") as Array<{
		id: string;
		name: string;
		arguments: Record<string, unknown>;
	}>;
	const msg: Record<string, unknown> = {
		role: "assistant",
		content: turn.blocks,
		model: MODEL,
		provider: PROVIDER,
		api: API,
		usage: {
			input: turn.usage.input,
			output: turn.usage.output,
			cacheRead: turn.usage.cacheRead,
			cacheWrite: turn.usage.cacheWrite,
			totalTokens: turn.usage.total,
			premiumRequests: turn.usage.premium,
			cost: turn.cost,
			...(turn.usage.reasoningTokens !== undefined
				? { reasoningTokens: turn.usage.reasoningTokens }
				: {}),
		},
		duration: turn.duration,
		ttft: turn.ttft,
		stopReason: turn.stopReason,
		timestamp: ts,
	};
	if (turn.errorMessage !== undefined) msg.errorMessage = turn.errorMessage;
	if (turn.errorId !== undefined) msg.errorId = turn.errorId;
	if (turn.errorStatus !== undefined) msg.errorStatus = turn.errorStatus;
	if (turn.responseId !== undefined) msg.responseId = turn.responseId;
	if (turn.stopDetails !== undefined) msg.stopDetails = turn.stopDetails;
	if (turn.contextSnapshot !== undefined) msg.contextSnapshot = turn.contextSnapshot;
	const line = JSON.stringify({
		type: "message",
		id: turn.entryId,
		parentId: null,
		timestamp: turn.iso,
		message: msg,
	});

	const toolRows: ToolRow[] = toolBlocks.map((b) => ({
		session_file: sessionFile,
		entry_id: turn.entryId,
		tool_call_id: b.id,
		folder,
		tool_name: b.name,
		model: MODEL,
		provider: PROVIDER,
		timestamp: ts,
		agent_type: "main",
		calls_in_turn: toolBlocks.length,
		args_chars: JSON.stringify(b.arguments).length,
		result_chars: null,
		is_error: null,
	}));

	const msgRow: MsgRow = {
		session_file: sessionFile,
		entry_id: turn.entryId,
		folder,
		model: MODEL,
		provider: PROVIDER,
		api: API,
		timestamp: ts,
		duration: turn.duration,
		ttft: turn.ttft,
		stop_reason: turn.stopReason,
		error_message: turn.errorMessage ?? null,
		input_tokens: turn.usage.input,
		output_tokens: turn.usage.output,
		cache_read_tokens: turn.usage.cacheRead,
		cache_write_tokens: turn.usage.cacheWrite,
		total_tokens: turn.usage.total,
		premium_requests: turn.usage.premium,
		cost_input: turn.cost.input,
		cost_output: turn.cost.output,
		cost_cache_read: turn.cost.cacheRead,
		cost_cache_write: turn.cost.cacheWrite,
		cost_total: turn.cost.total,
		agent_type: "main",
	};

	return { line, msgRow, toolRows };
}

function toolResultLine(
	entryId: string,
	iso: string,
	toolCallId: string,
	isError: boolean,
	content: string,
	extra: Record<string, unknown> = {},
): string {
	return JSON.stringify({
		type: "message",
		id: entryId,
		parentId: null,
		timestamp: iso,
		message: {
			role: "toolResult",
			toolCallId,
			isError,
			content: [{ type: "text", text: content }],
			...extra,
		},
	});
}

/** Link a tool-result to its tool_calls row (fills result_chars / is_error). */
function linkResult(
	toolRows: ToolRow[],
	toolCallId: string,
	content: string,
	isError: boolean,
): void {
	const r = toolRows.find((t) => t.tool_call_id === toolCallId);
	if (r) {
		r.result_chars = content.length;
		r.is_error = isError ? 1 : 0;
	}
}

// ---------------------------------------------------------------------------
// Session data
// ---------------------------------------------------------------------------

interface SessionData {
	relFile: string;
	absFile: string;
	dbFile: string;
	folder: string;
	lines: string[];
	msgRows: MsgRow[];
	toolRows: ToolRow[];
	userRows: UserRow[];
	/** epoch ms of each linked tool result, keyed by toolCallId */
	resultTsByCall: Map<string, number>;
	/** epoch ms of each tool_execution_start custom entry, keyed by toolCallId */
	startedAtByCall: Map<string, number>;
	/** tool-call arguments as written to JSONL, keyed by toolCallId */
	argsByCall: Map<string, unknown>;
}

function newSession(folder: string, fileName: string, dbFile?: string): SessionData {
	const relFile = `${folder}/${fileName}`;
	return {
		relFile,
		absFile: join(SESSIONS_DIR, relFile),
		dbFile: dbFile ?? join(SESSIONS_DIR, relFile),
		folder,
		lines: [],
		msgRows: [],
		toolRows: [],
		userRows: [],
		resultTsByCall: new Map(),
		startedAtByCall: new Map(),
		argsByCall: new Map(),
	};
}

const main = (turn: Turn, s: SessionData): void => {
	const { line, msgRow, toolRows } = assistantLine(turn, s.dbFile, s.folder);
	s.lines.push(line);
	s.msgRows.push(msgRow);
	s.toolRows.push(...toolRows);
	for (const b of turn.blocks) {
		if (b.type !== "toolCall") continue;
		s.argsByCall.set(String(b.id), b.arguments);
	}
};

/** user-message text stats as stored in stats.db (sparse table — only synced rows appear) */
type UserTextStats = Omit<
	UserRow,
	"session_file" | "entry_id" | "folder" | "timestamp" | "model" | "provider"
>;

const user = (
	entryId: string,
	iso: string,
	content: string,
	s: SessionData,
	dbRow?: UserTextStats,
): void => {
	s.lines.push(userLine(entryId, iso, content));
	if (dbRow) {
		s.userRows.push({
			session_file: s.dbFile,
			entry_id: entryId,
			folder: s.folder,
			timestamp: Date.parse(iso),
			model: MODEL,
			provider: PROVIDER,
			...dbRow,
		});
	}
};

const result = (
	entryId: string,
	iso: string,
	toolCallId: string,
	content: string,
	s: SessionData,
	isError = false,
	extra?: Record<string, unknown>,
): void => {
	s.lines.push(toolResultLine(entryId, iso, toolCallId, isError, content, extra));
	s.resultTsByCall.set(toolCallId, Date.parse(iso));
	linkResult(s.toolRows, toolCallId, content, isError);
};

const sys = (
	type: string,
	id: string,
	iso: string,
	s: SessionData,
	extra?: Record<string, unknown>,
): void => {
	s.lines.push(sysLine(type, id, iso, extra));
};

/** Mark the moment a tool actually started executing (custom entry in the real corpus). */
const execStart = (
	entryId: string,
	iso: string,
	toolCallId: string,
	toolName: string,
	args: Record<string, unknown>,
	s: SessionData,
	intent?: string,
): void => {
	const data: Record<string, unknown> = { toolCallId, toolName, startedAt: iso, args };
	if (intent !== undefined) data.intent = intent;
	s.lines.push(
		JSON.stringify({
			type: "custom",
			id: entryId,
			parentId: null,
			timestamp: iso,
			customType: "tool_execution_start",
			data,
		}),
	);
	s.startedAtByCall.set(toolCallId, Date.parse(iso));
};

// --- proj-a: the rich session (parallel calls, error turn, pending call, garbage tail) ---
const A = newSession(FOLDER_A, "2026-01-01T10-00-00-000Z_aaaa.jsonl");
A.lines.push(
	titleSlot("Alpha Session", "2026-01-01T10:00:00.000Z"),
	sessionHeader(
		"019f3389-f804-7000-b786-e5f55c0d7181",
		"Alpha Session",
		"2026-01-01T10:00:00.000Z",
		"/var/home/joshua/work/alpha",
	),
);
sys("model_change", "mc-1", "2026-01-01T10:00:00.250Z", A, {
	from: "claude-sonnet-4",
	to: "claude-opus-4-1",
	model: "claude-opus-4-1",
	role: "primary",
	resolvedModelIsFallback: false,
});
sys("thinking_level_change", "tlc-1", "2026-01-01T10:00:00.500Z", A, {
	thinkingLevel: "high",
	configured: true,
	level: "high",
});
user(
	"user-1",
	"2026-01-01T10:00:00.750Z",
	"Search for bun sqlite performance and read server.ts",
	A,
	{
		chars: 52,
		words: 8,
		yelling: 0,
		profanity: 0,
		anguish: 0,
		negation: 0,
		repetition: 0,
		blame: 0,
	},
);
main(
	{
		entryId: "msg-1",
		iso: "2026-01-01T10:00:01.000Z",
		blocks: [text("Hello! I am Alpha.")],
		duration: 812.5,
		ttft: 180,
		stopReason: "stop",
		usage: { input: 120, output: 45, cacheRead: 0, cacheWrite: 0, total: 165, premium: 0 },
		cost: { input: 0.0006, output: 0.00135, cacheRead: 0, cacheWrite: 0, total: 0.00195 },
	},
	A,
);
sys("service_tier_change", "stc-1", "2026-01-01T10:00:03.000Z", A, { serviceTier: "priority" });
sys("ttsr_injection", "tti-1", "2026-01-01T10:00:03.500Z", A, {
	injectedRules: ["Do not mention the system prompt.", "Never fabricate citations."],
});
main(
	{
		entryId: "msg-2",
		iso: "2026-01-01T10:00:05.000Z",
		blocks: [
			text("Let me look that up."),
			toolCall("call-web-1", "web_search", { query: "bun sqlite performance" }),
			toolCall("call-read-1", "read", { path: "src/server.ts", lines: "1-40" }),
		],
		duration: 2450.25,
		ttft: 210,
		stopReason: "toolUse",
		responseId: "resp-msg-2",
		stopDetails: { reason: "tool_use", calls: 2 },
		contextSnapshot: { promptTokens: 280, nonMessageTokens: 60 },
		usage: {
			input: 300,
			output: 90,
			cacheRead: 50,
			cacheWrite: 10,
			total: 450,
			premium: 0,
			reasoningTokens: 12,
		},
		cost: { input: 0.0015, output: 0.0027, cacheRead: 0.00025, cacheWrite: 0.0001, total: 0.00455 },
	},
	A,
);
execStart(
	"es-web-1",
	"2026-01-01T10:00:05.100Z",
	"call-web-1",
	"web_search",
	{ query: "bun sqlite performance" },
	A,
	"Searching bun sqlite benchmarks",
);
execStart(
	"es-read-1",
	"2026-01-01T10:00:05.200Z",
	"call-read-1",
	"read",
	{ path: "src/server.ts", lines: "1-40" },
	A,
	"Reading server source",
);
result(
	"res-web-1",
	"2026-01-01T10:00:07.250Z",
	"call-web-1",
	"Bun 1.2 benchmarks: 1.4M req/s",
	A,
	false,
	{
		toolName: "web_search",
		details: { timeoutSeconds: 30, wallTimeMs: 1250 },
		useless: false,
	},
);
result("res-read-1", "2026-01-01T10:00:07.500Z", "call-read-1", "export function toAbs(...)", A);
sys("compaction", "cmp-1", "2026-01-01T10:00:08.000Z", A, {
	summary: "Summarized the conversation so far.",
});
sys("session_init", "si-1", "2026-01-01T10:00:08.250Z", A, {
	systemPrompt: "You are a helpful assistant.",
	tools: ["read", "edit", "bash", "web_search", "grep"],
	resolvedModel: MODEL,
	modelRole: "primary",
	agent: "main",
	readOnly: false,
});
sys("label", "lb-1", "2026-01-01T10:00:08.500Z", A, { label: "alpha work" });
sys("custom", "cus-1", "2026-01-01T10:00:08.750Z", A, { key: "custom-key", value: "custom-value" });
sys("custom_message", "cusm-1", "2026-01-01T10:00:08.875Z", A, {
	customType: "custom_message",
	content: "A custom message payload.",
	display: "banner",
	details: { notes: [{ note: "Fixture note for notes rendering", severity: "info" }] },
});
sys("title_change", "tc-1", "2026-01-01T10:00:08.900Z", A, {
	previousTitle: "Alpha Session",
	title: "Alpha Session v2",
	source: "auto",
	trigger: "first_message",
});
sys("credential_pin", "cp-1", "2026-01-01T10:00:08.950Z", A);
// New-accessor coverage block (types the viewer renders exhaustively).
sys("mode_change", "moc-1", "2026-01-01T10:00:08.960Z", A, {
	mode: "plan",
	data: { planFilePath: "docs/plan.md" },
});
A.lines.push(
	JSON.stringify({
		type: "message",
		id: "dev-1",
		parentId: null,
		timestamp: "2026-01-01T10:00:08.965Z",
		message: {
			role: "developer",
			content: [{ type: "text", text: "System: stay concise and verify claims before asserting." }],
		},
	}),
);
A.lines.push(
	JSON.stringify({
		type: "message",
		id: "fm-1",
		parentId: null,
		timestamp: "2026-01-01T10:00:08.970Z",
		message: {
			role: "fileMention",
			files: [{ path: "src/server.ts", content: "export const PORT = 3971;" }],
		},
	}),
);
A.lines.push(
	JSON.stringify({
		type: "message",
		id: "user-1x",
		parentId: null,
		timestamp: "2026-01-01T10:00:08.975Z",
		message: {
			role: "user",
			content: [{ type: "text", text: "Keep the session viewer transcript exhaustive." }],
			attribution: "user",
			steering: true,
			synthetic: false,
		},
	}),
);
sys("custom", "sx-1", "2026-01-01T10:00:08.980Z", A, {
	customType: "session_exit",
	data: { kind: "subagent", reason: "completed", recordedAt: "2026-01-01T10:00:20.500Z" },
});
sys("custom", "gc-1", "2026-01-01T10:00:08.985Z", A, {
	customType: "goal-completed",
	data: {
		objective: "Make the session viewer transcript exhaustive",
		timeUsedSeconds: 12.5,
		tokensUsed: 2345,
	},
});
main(
	{
		entryId: "msg-3",
		iso: "2026-01-01T10:00:09.000Z",
		blocks: [
			toolCall("call-edit-1", "edit", { path: "src/server.ts", oldString: "a", newString: "b" }),
		],
		duration: 312.75,
		ttft: 95,
		stopReason: "error",
		errorMessage: "Invalid edit: multiple matches for oldString",
		errorId: "err-edit-1",
		errorStatus: 400,
		usage: { input: 50, output: 0, cacheRead: 0, cacheWrite: 0, total: 50, premium: 0 },
		cost: { input: 0.00025, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.00025 },
	},
	A,
);
// Unsynced tail (stats.db stops at msg-3 — like a partially synced real session).
sys("model_change", "mc-2", "2026-01-01T10:00:10.000Z", A, {
	from: "claude-opus-4-1",
	to: "claude-sonnet-4",
	model: "claude-sonnet-4",
	role: "primary",
	resolvedModelIsFallback: false,
});
sys("thinking_level_change", "tlc-2", "2026-01-01T10:00:10.100Z", A, {
	thinkingLevel: "low",
	configured: false,
	level: "low",
});
sys("custom_message", "cusm-2", "2026-01-01T10:00:10.200Z", A, {
	content: "Another custom message.",
});
user("user-2", "2026-01-01T10:00:10.300Z", "What about the subagents?", A);
// Unsynced assistant turns (JSONL only — no stats.db rows, like a session the
// sync worker hasn't caught up with yet).
A.lines.push(
	assistantLine(
		{
			entryId: "msg-4",
			iso: "2026-01-01T10:00:10.500Z",
			blocks: [text("Another thought.")],
			duration: 300,
			ttft: 50,
			stopReason: "stop",
			usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, total: 30, premium: 0 },
			cost: { input: 0.0001, output: 0.0003, cacheRead: 0, cacheWrite: 0, total: 0.0004 },
		},
		A.dbFile,
		A.folder,
	).line,
);
sys("compaction", "cmp-2", "2026-01-01T10:00:11.000Z", A, { summary: "Second compaction." });
sys("ttsr_injection", "tti-2", "2026-01-01T10:00:11.100Z", A, {
	injectedRules: ["Answer in the user's language."],
});
sys("custom", "cus-2", "2026-01-01T10:00:11.200Z", A, { key: "k2", value: "v2" });
sys("label", "lb-2", "2026-01-01T10:00:11.300Z", A, { label: "alpha work 2" });
sys("session_init", "si-2", "2026-01-01T10:00:11.400Z", A, {
	systemPrompt: "Context restored.",
	tools: ["read", "edit", "bash"],
	resolvedModel: MODEL,
	modelRole: "primary",
	outputSchemaMode: "permissive",
	readOnly: false,
});
sys("title_change", "tc-2", "2026-01-01T10:00:11.500Z", A, {
	previousTitle: "Alpha Session v2",
	title: "Alpha Session",
	source: "manual",
	trigger: "user",
});
user("user-3", "2026-01-01T10:00:11.600Z", "Anything else?", A);
A.lines.push(
	assistantLine(
		{
			entryId: "msg-5",
			iso: "2026-01-01T10:00:11.800Z",
			blocks: [text("Final note.")],
			duration: 250,
			ttft: 40,
			stopReason: "stop",
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, premium: 0 },
			cost: { input: 0.00005, output: 0.00015, cacheRead: 0, cacheWrite: 0, total: 0.0002 },
		},
		A.dbFile,
		A.folder,
	).line,
);
sys("thinking_level_change", "tlc-3", "2026-01-01T10:00:12.000Z", A, {
	thinkingLevel: "high",
	configured: true,
	level: "high",
});
sys("model_change", "mc-3", "2026-01-01T10:00:12.100Z", A, {
	from: "claude-sonnet-4",
	to: "claude-opus-4-1",
	model: "claude-opus-4-1",
	role: "primary",
	resolvedModelIsFallback: false,
});
sys("service_tier_change", "stc-2", "2026-01-01T10:00:12.200Z", A, { serviceTier: "standard" });
sys("custom_message", "cusm-3", "2026-01-01T10:00:12.300Z", A, {
	content: "One more custom message.",
});
sys("credential_pin", "cp-2", "2026-01-01T10:00:12.400Z", A);
sys("compaction", "cmp-3", "2026-01-01T10:00:12.500Z", A, { summary: "Third compaction." });
sys("label", "lb-3", "2026-01-01T10:00:12.600Z", A, { label: "alpha work 3" });
// Fully-enriched assistant message: every field assistantMetaOf() reads.
A.lines.push(
	JSON.stringify({
		type: "message",
		id: "msg-6",
		parentId: null,
		timestamp: "2026-01-01T10:00:12.700Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Enriched final answer with full metadata." }],
			model: MODEL,
			provider: PROVIDER,
			api: API,
			ttft: 88,
			responseId: "resp-msg-6",
			stopDetails: { reason: "end_turn" },
			contextSnapshot: { promptTokens: 1800, nonMessageTokens: 420 },
			usage: {
				input: 500,
				output: 120,
				cacheRead: 60,
				cacheWrite: 20,
				reasoningTokens: 64,
				totalTokens: 700,
				premiumRequests: 0,
				cost: {
					input: 0.0025,
					output: 0.0036,
					cacheRead: 0.0003,
					cacheWrite: 0.0002,
					total: 0.0066,
				},
			},
			duration: 900,
			stopReason: "stop",
			timestamp: Date.parse("2026-01-01T10:00:12.700Z"),
		},
	}),
);
// Corrupt/truncated trailing line — must be skipped by lenient parsing.
A.lines.push(
	'{"type":"message","id":"msg-99","parentId":null,"timestamp":"2026-01-01T10:00:13.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Unfinished',
);

// --- proj-b: normal session, 2 turns, single edit call ---
const B = newSession(FOLDER_B, "2026-01-02T10-00-00-000Z_bbbb.jsonl");
B.lines.push(
	titleSlot("Beta Session", "2026-01-02T10:00:00.000Z"),
	sessionHeader(
		"019f3389-f804-7000-b786-e5f55c0d7182",
		"Beta Session",
		"2026-01-02T10:00:00.000Z",
		"/var/home/joshua/work/beta",
	),
);
user("user-b1", "2026-01-02T10:00:00.500Z", "Please update the README.", B);
main(
	{
		entryId: "msg-b1",
		iso: "2026-01-02T10:00:01.000Z",
		blocks: [text("Starting work.")],
		duration: 400,
		ttft: 60,
		stopReason: "stop",
		usage: { input: 80, output: 20, cacheRead: 0, cacheWrite: 0, total: 100, premium: 0 },
		cost: { input: 0.0004, output: 0.0006, cacheRead: 0, cacheWrite: 0, total: 0.001 },
	},
	B,
);
main(
	{
		entryId: "msg-b2",
		iso: "2026-01-02T10:00:05.000Z",
		blocks: [toolCall("call-edit-b1", "edit", { file: "README.md", change: "add docs" })],
		duration: 1500,
		ttft: 100,
		stopReason: "toolUse",
		usage: { input: 200, output: 60, cacheRead: 0, cacheWrite: 0, total: 260, premium: 0 },
		cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
	},
	B,
);
// call-edit-b1 deliberately has NO tool_execution_start entry — the UNTIMED
// case: it still counts (calls/errors/resultChars) but contributes NO
// duration, so edit shows totalMs 0, avgMs null, maxMs null and proj-b's
// longestCall is null. Pending still means "no result entry", so this is
// NOT pending (it has a result).
result("res-b1", "2026-01-02T10:00:06.000Z", "call-edit-b1", "Applied edit to README.md", B);

// --- proj-c: on disk, NO stats.db rows (never synced) ---
const C = newSession(FOLDER_C, "2026-01-03T10-00-00-000Z_cccc.jsonl");
C.lines.push(
	titleSlot("Gamma Session", "2026-01-03T10:00:00.000Z"),
	sessionHeader(
		"019f3389-f804-7000-b786-e5f55c0d7183",
		"Gamma Session",
		"2026-01-03T10:00:00.000Z",
		"/var/home/joshua/work/gamma",
	),
);
user("user-c1", "2026-01-03T10:00:00.500Z", "What's the plan?", C);
C.lines.push(
	JSON.stringify({
		type: "message",
		id: "msg-c1",
		parentId: null,
		timestamp: "2026-01-03T10:00:01.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Nothing to see here yet." }],
			model: MODEL,
			provider: PROVIDER,
			api: API,
			duration: 350,
			ttft: 55,
			stopReason: "stop",
			timestamp: Date.parse("2026-01-03T10:00:01.000Z"),
		},
	}),
);

// --- proj-d: stats.db rows only; file intentionally NOT written to disk.
//     Stored with a RELATIVE session_file to cover the schema-comment case. ---
const D = newSession(
	FOLDER_D,
	"2026-01-04T10-00-00-000Z_dddd.jsonl",
	`proj-d/2026-01-04T10-00-00-000Z_dddd.jsonl`,
);
D.msgRows.push({
	session_file: D.dbFile,
	entry_id: "msg-d1",
	folder: D.folder,
	model: MODEL,
	provider: PROVIDER,
	api: API,
	timestamp: Date.parse("2026-01-04T10:00:01.000Z"),
	duration: 600.5,
	ttft: 70,
	stop_reason: "stop",
	error_message: null,
	input_tokens: 150,
	output_tokens: 30,
	cache_read_tokens: 0,
	cache_write_tokens: 0,
	total_tokens: 180,
	premium_requests: 0,
	cost_input: 0.001,
	cost_output: 0.001,
	cost_cache_read: 0,
	cost_cache_write: 0,
	cost_total: 0.002,
	agent_type: "main",
});
D.toolRows.push({
	session_file: D.dbFile,
	entry_id: "msg-d1",
	tool_call_id: "call-bash-d1",
	folder: D.folder,
	tool_name: "bash",
	model: MODEL,
	provider: PROVIDER,
	timestamp: Date.parse("2026-01-04T10:00:01.000Z"),
	agent_type: "main",
	calls_in_turn: 1,
	args_chars: JSON.stringify({ cmd: "ls -la tmp" }).length,
	result_chars: 45,
	is_error: 0,
});

// --- subagent / advisor transcripts under proj-a's session dir ---
// Real omp names the subagent directory after the session file WITHOUT the
// `.jsonl` extension (a file and a directory cannot share the same name):
//   <proj>/<file>.jsonl           main session
//   <proj>/<file>/<id>.jsonl      subagent transcripts
const subDir = join(SESSIONS_DIR, "proj-a", "2026-01-01T10-00-00-000Z_aaaa");
const subFiles: Record<string, string> = {
	"SubOne.jsonl":
		[
			titleSlot("SubOne", "2026-01-01T10:00:20.000Z"),
			sessionHeader(
				"019f3389-f804-7000-b786-e5f55c0d7184",
				null,
				"2026-01-01T10:00:20.000Z",
				"/var/home/joshua/work/alpha",
			),
			JSON.stringify({
				type: "session_init",
				id: "sub-si-1",
				parentId: "msg-2",
				timestamp: "2026-01-01T10:00:20.500Z",
				systemPrompt: "You are a subagent. Answer precisely from the provided files.",
				tools: ["read", "grep"],
				resolvedModel: MODEL,
				modelRole: "primary",
				agent: "scout",
				task: "Investigate bun sqlite performance and report findings.",
				spawns: [],
				outputSchema: null,
				outputSchemaMode: "permissive",
				readOnly: true,
				readSummarize: true,
			}),
			JSON.stringify({
				type: "message",
				id: "sub-msg-1",
				parentId: "msg-2",
				timestamp: "2026-01-01T10:00:21.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Subagent result: 42." }],
					timestamp: Date.parse("2026-01-01T10:00:21.000Z"),
				},
			}),
		].join("\n") + "\n",
	"__advisor.jsonl":
		[
			titleSlot("Advisor", "2026-01-01T10:00:22.000Z"),
			sessionHeader(
				"019f3389-f804-7000-b786-e5f55c0d7185",
				null,
				"2026-01-01T10:00:22.000Z",
				"/var/home/joshua/work/alpha",
			),
			JSON.stringify({
				type: "message",
				id: "adv-msg-1",
				parentId: "msg-2",
				timestamp: "2026-01-01T10:00:23.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Advisory note: keep it simple." }],
					timestamp: Date.parse("2026-01-01T10:00:23.000Z"),
				},
			}),
		].join("\n") + "\n",
};

// ---------------------------------------------------------------------------
// Expected values (exported for tests — derived from the same literals)
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number | null {
	if (sorted.length === 0) return null;
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[idx]!;
}

interface ExpectedTool {
	calls: number;
	errors: number;
	pending: number;
	totalMs: number;
	avgMs: number | null;
	maxMs: number | null;
	argsChars: number;
	resultChars: number;
}

function expectedTools(s: SessionData, hasJsonl: boolean): Record<string, ExpectedTool> {
	const byName = new Map<string, ExpectedTool>();
	const timedByTool = new Map<string, number>();
	for (const t of s.toolRows) {
		let e = byName.get(t.tool_name);
		if (!e) {
			e = {
				calls: 0,
				errors: 0,
				pending: 0,
				totalMs: 0,
				avgMs: null,
				maxMs: null,
				argsChars: 0,
				resultChars: 0,
			};
			byName.set(t.tool_name, e);
		}
		e.calls++;
		e.errors += t.is_error ?? 0;
		e.argsChars += t.args_chars;
		e.resultChars += t.result_chars ?? 0;
		if (t.result_chars === null || !hasJsonl) {
			// Unlinked calls are pending; without the JSONL there are no durations at all.
			if (t.result_chars === null) e.pending++;
			continue;
		}
		const resTs = s.resultTsByCall.get(t.tool_call_id);
		if (resTs === undefined) continue;
		const startTs = s.startedAtByCall.get(t.tool_call_id);
		if (startTs === undefined) continue; // untimed: counted above, but contributes NO duration
		const dur = Math.max(0, resTs - startTs);
		timedByTool.set(t.tool_name, (timedByTool.get(t.tool_name) ?? 0) + 1);
		e.totalMs += dur;
		if (e.maxMs === null || dur > e.maxMs) {
			e.maxMs = dur;
		}
	}
	for (const [toolName, e] of byName) {
		const timed = timedByTool.get(toolName) ?? 0;
		e.avgMs = hasJsonl && timed > 0 ? e.totalMs / timed : null;
	}
	return Object.fromEntries([...byName.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

function expectedLongest(
	s: SessionData,
): { toolName: string; toolCallId: string; durationMs: number; args: string } | null {
	let best: { toolName: string; toolCallId: string; durationMs: number; args: string } | null =
		null;
	let bestMs = -1;
	for (const t of s.toolRows) {
		if (t.result_chars === null) continue;
		const resTs = s.resultTsByCall.get(t.tool_call_id);
		if (resTs === undefined) continue;
		const startTs = s.startedAtByCall.get(t.tool_call_id);
		if (startTs === undefined) continue; // untimed: no duration, never a candidate
		const dur = Math.max(0, resTs - startTs);
		if (dur <= bestMs) continue;
		bestMs = dur;
		best = {
			toolName: t.tool_name,
			toolCallId: t.tool_call_id,
			durationMs: dur,
			args: JSON.stringify(s.argsByCall.get(t.tool_call_id) ?? {}),
		};
	}
	return best;
}

function validLineCount(lines: string[]): number {
	let n = 0;
	for (const l of lines) {
		try {
			JSON.parse(l);
			n++;
		} catch {
			// garbage — skipped
		}
	}
	return n;
}

const sessions = [A, B, C, D];

const aDurations = A.msgRows.map((r) => r.duration!).sort((x, y) => x - y);
const bTurns = B.msgRows.length;
const bTools = B.toolRows.length;
const bTokens = B.msgRows.reduce((s, r) => s + r.total_tokens, 0);
const bCost = B.msgRows.reduce((s, r) => s + r.cost_total, 0);

export const EXPECT = {
	health: {
		// server.ts sessionCount() counts *.jsonl-named direct children of each
		// project dir. The fixture has 3 main files on disk; the subagent dir is
		// named WITHOUT the .jsonl suffix (real omp layout — a file and a dir
		// cannot share one name), so it is not counted. The sessions LIST reports
		// 4 (3 disk + proj-d DB-only).
		sessionsCount: 3,
		dbCounts: {
			messages: sessions.reduce((s, x) => s + x.msgRows.length, 0),
			toolCalls: sessions.reduce((s, x) => s + x.toolRows.length, 0),
			userMessages: sessions.reduce((s, x) => s + x.userRows.length, 0),
		},
	},
	sessions: {
		count: 4,
		projA: {
			file: A.relFile,
			folder: A.folder,
			title: "Alpha Session",
			id: "019f3389-f804-7000-b786-e5f55c0d7181",
			cwd: "/var/home/joshua/work/alpha",
			firstTs: Math.min(...A.msgRows.map((r) => r.timestamp)),
			lastTs: Math.max(...A.msgRows.map((r) => r.timestamp)),
			turns: A.msgRows.length,
			toolCalls: A.toolRows.length,
			totalTokens: A.msgRows.reduce((s, r) => s + r.total_tokens, 0),
			totalCost: A.msgRows.reduce((s, r) => s + r.cost_total, 0),
			errorTurns: A.msgRows.filter((r) => r.stop_reason === "error").length,
			modelCount: new Set(A.msgRows.map((r) => r.model)).size,
			userMessages: A.userRows.length,
			userChars: A.userRows.reduce((s, r) => s + r.chars, 0),
		},
		projB: {
			file: B.relFile,
			title: "Beta Session",
			turns: bTurns,
			toolCalls: bTools,
			totalTokens: bTokens,
			totalCost: bCost,
			errorTurns: 0,
		},
		projC: {
			file: C.relFile,
			title: "Gamma Session",
			turns: 0,
			toolCalls: 0,
		},
		projD: {
			file: "proj-d/2026-01-04T10-00-00-000Z_dddd.jsonl",
			turns: D.msgRows.length,
			toolCalls: D.toolRows.length,
			totalTokens: D.msgRows.reduce((s, r) => s + r.total_tokens, 0),
			totalCost: D.msgRows.reduce((s, r) => s + r.cost_total, 0),
			onDisk: false,
			synced: true,
		},
	},
	projAStats: {
		turns: A.msgRows.length,
		toolCalls: A.toolRows.length,
		tools: expectedTools(A, true),
		longestCall: expectedLongest(A),
		latency: { p50: percentile(aDurations, 50), p90: percentile(aDurations, 90) },
		totals: {
			tokens: A.msgRows.reduce((s, r) => s + r.total_tokens, 0),
			cost: A.msgRows.reduce((s, r) => s + r.cost_total, 0),
		},
		errors: A.msgRows
			.filter((r) => r.stop_reason === "error")
			.map((r) => ({
				timestamp: r.timestamp,
				model: r.model,
				message: r.error_message,
			})),
		user: { count: A.userRows.length, chars: A.userRows.reduce((s, r) => s + r.chars, 0) },
	},
	transcript: {
		projAValidEntries: validLineCount(A.lines),
	},
	subagents: {
		projA: ["SubOne.jsonl", "__advisor.jsonl"].sort(),
		projB: [] as string[],
	},
	toolsGlobal: {
		web_search: { calls: 1, errors: 0, sessions: 1 },
	},
	security: {
		traversal: "/ctl/stats/sessions/..%2F..%2Fstats.db/transcript",
		absolute: "/ctl/stats/sessions/%2Fetc%2Fpasswd/stats",
	},
};

// ---------------------------------------------------------------------------
// Disk + DB writing (only when executed directly)
// ---------------------------------------------------------------------------

function writeDb(all: SessionData[]): void {
	const db = new Database(STATS_DB_PATH);
	db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_file TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      folder TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      api TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      duration REAL,
      ttft REAL,
      stop_reason TEXT NOT NULL,
      error_message TEXT,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      premium_requests REAL NOT NULL,
      cost_input REAL NOT NULL,
      cost_output REAL NOT NULL,
      cost_cache_read REAL NOT NULL,
      cost_cache_write REAL NOT NULL,
      cost_total REAL NOT NULL,
      agent_type TEXT NOT NULL DEFAULT 'main',
      UNIQUE(session_file, entry_id)
    );
    CREATE TABLE tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_file TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      folder TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      agent_type TEXT NOT NULL DEFAULT 'main',
      calls_in_turn INTEGER NOT NULL DEFAULT 1,
      args_chars INTEGER NOT NULL DEFAULT 0,
      result_chars INTEGER,
      is_error INTEGER,
      UNIQUE(session_file, tool_call_id)
    );
    CREATE TABLE user_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_file TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      folder TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      chars INTEGER NOT NULL,
      words INTEGER NOT NULL,
      yelling INTEGER NOT NULL DEFAULT 0,
      profanity INTEGER NOT NULL DEFAULT 0,
      anguish INTEGER NOT NULL DEFAULT 0,
      negation INTEGER NOT NULL DEFAULT 0,
      repetition INTEGER NOT NULL DEFAULT 0,
      blame INTEGER NOT NULL DEFAULT 0,
      UNIQUE(session_file, entry_id)
    );
    CREATE TABLE file_offsets (
      session_file TEXT PRIMARY KEY,
      offset INTEGER NOT NULL,
      last_modified INTEGER NOT NULL
    );
    CREATE TABLE meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE INDEX idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX idx_messages_model ON messages(model);
    CREATE INDEX idx_messages_folder ON messages(folder);
    CREATE INDEX idx_messages_session_file ON messages(session_file);
    CREATE INDEX idx_messages_ts_model_provider ON messages(timestamp, model, provider);
    CREATE INDEX idx_messages_ts_folder ON messages(timestamp, folder);
    CREATE INDEX idx_messages_stop_reason_ts ON messages(stop_reason, timestamp);
    CREATE INDEX idx_tool_calls_timestamp ON tool_calls(timestamp);
    CREATE INDEX idx_tool_calls_tool_ts ON tool_calls(tool_name, timestamp);
  `);

	const insMsg = db.prepare(
		`INSERT INTO messages (
       session_file, entry_id, folder, model, provider, api, timestamp, duration, ttft,
       stop_reason, error_message, input_tokens, output_tokens, cache_read_tokens,
       cache_write_tokens, total_tokens, premium_requests, cost_input, cost_output,
       cost_cache_read, cost_cache_write, cost_total, agent_type
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const insTool = db.prepare(
		`INSERT INTO tool_calls (
       session_file, entry_id, tool_call_id, folder, tool_name, model, provider,
       timestamp, agent_type, calls_in_turn, args_chars, result_chars, is_error
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const insUser = db.prepare(
		`INSERT INTO user_messages (
       session_file, entry_id, folder, timestamp, model, provider, chars, words,
       yelling, profanity, anguish, negation, repetition, blame
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const insOffset = db.prepare(
		`INSERT INTO file_offsets (session_file, offset, last_modified) VALUES (?, ?, ?)`,
	);
	const insMeta = db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)`);

	db.exec("BEGIN");
	try {
		for (const s of all) {
			for (const r of s.msgRows) {
				insMsg.run(
					r.session_file,
					r.entry_id,
					r.folder,
					r.model,
					r.provider,
					r.api,
					r.timestamp,
					r.duration,
					r.ttft,
					r.stop_reason,
					r.error_message,
					r.input_tokens,
					r.output_tokens,
					r.cache_read_tokens,
					r.cache_write_tokens,
					r.total_tokens,
					r.premium_requests,
					r.cost_input,
					r.cost_output,
					r.cost_cache_read,
					r.cost_cache_write,
					r.cost_total,
					r.agent_type,
				);
			}
			for (const r of s.toolRows) {
				insTool.run(
					r.session_file,
					r.entry_id,
					r.tool_call_id,
					r.folder,
					r.tool_name,
					r.model,
					r.provider,
					r.timestamp,
					r.agent_type,
					r.calls_in_turn,
					r.args_chars,
					r.result_chars,
					r.is_error,
				);
			}
			for (const r of s.userRows) {
				insUser.run(
					r.session_file,
					r.entry_id,
					r.folder,
					r.timestamp,
					r.model,
					r.provider,
					r.chars,
					r.words,
					r.yelling,
					r.profanity,
					r.anguish,
					r.negation,
					r.repetition,
					r.blame,
				);
			}
		}
		// Sync bookkeeping: one row per synced session (proj-a, proj-b, proj-d).
		const offsets: Array<[string, number, number]> = [
			[A.dbFile, 4096, A.msgRows[A.msgRows.length - 1]!.timestamp],
			[B.dbFile, 2048, B.msgRows[B.msgRows.length - 1]!.timestamp],
			[D.dbFile, 1024, D.msgRows[0]!.timestamp],
		];
		for (const [f, off, mod] of offsets) insOffset.run(f, off, mod);
		insMeta.run("schema_version", "1");
		insMeta.run("source", "session-viewer fixture");
		db.exec("COMMIT");
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
	db.close();
}

if (import.meta.main) {
	rmSync(FIXTURE_ROOT, { recursive: true, force: true });
	mkdirSync(SESSIONS_DIR, { recursive: true });
	mkdirSync(subDir, { recursive: true });

	for (const s of sessions) {
		if (s.lines.length === 0) continue;
		mkdirSync(dirname(s.absFile), { recursive: true });
		writeFileSync(s.absFile, s.lines.join("\n") + "\n");
	}
	for (const [name, content] of Object.entries(subFiles)) {
		writeFileSync(join(subDir, name), content);
	}

	writeDb(sessions);
	console.log(
		`fixture regenerated at ${FIXTURE_ROOT}: ${EXPECT.health.dbCounts.messages} messages, ` +
			`${EXPECT.health.dbCounts.toolCalls} tool_calls, ${EXPECT.health.dbCounts.userMessages} user_messages, ` +
			`${validLineCount(A.lines)} valid JSONL lines in proj-a (1 corrupt line skipped)`,
	);
}
