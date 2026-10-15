import type { Model } from "@oh-my-pi/pi-ai";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { ResolvedAnthropicCompat } from "@oh-my-pi/pi-catalog/types";
import type { AskQuestion, UiRequest } from "../../web/prompt/ask-types";
import type { SettingsSection } from "../../web/components/settings/SettingsNav";
import { settingsSectionId } from "../../web/prefs/settings-tabs";
import type { BtwRecordView } from "../../web/store/btw-history";
import type { BrowserUiRequest } from "../../web/store/browser-ui";
import type { DownloadConsent, WebDownloadManifest } from "../../web/store/downloads";
import type { McpServerEntry, PluginEntry, SkillEntry } from "../../web/store/slices/integrations";
import type { ModelPreset } from "../../web/store/models";
import type { ForeignSessionPreview, ResumeCandidate } from "../../web/store/resume";
import type { BrowserUiContribution } from "#lib/wire/browser-ui-contract";
import type {
	ContextUsageBreakdown,
	SessionStats,
} from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import type {
	ModelInfo,
	ModelRoleCatalogEntry,
	SessionListEntry,
	SettingsItem,
	SettingsModel,
} from "#lib/wire/protocol";

const T0 = Date.parse("2026-10-09T10:00:00Z");
const MIN = 60_000;

// ---------------------------------------------------------------------------
// Ask dialog: the questions a model asks the operator.
// ---------------------------------------------------------------------------

/** QuestionsForm: single-choice question with a recommended option and per-option previews. */
const askScope: AskQuestion = {
	id: "q_scope",
	question: "Which surface should the copy button cover?",
	header: "Scope",
	options: [
		{
			label: "Fenced blocks only",
			description: "Markdown fences in assistant and user messages.",
			preview: "```ts\nconst x = 1;\n```",
		},
		{ label: "Inline code too", description: "Adds single-backtick spans; more hit-testing work." },
		{ label: "Whole message", description: "Copies the rendered plain text of the message." },
	],
	recommended: 0,
};

/** QuestionsForm: multi-select question for which checks to run before the commit. */
const askChecks: AskQuestion = {
	id: "q_checks",
	question: "Which checks should run before committing?",
	header: "Checks",
	options: [
		{ label: "bun run check:types" },
		{ label: "bun run lint" },
		{ label: "bun test apps/web" },
		{ label: "bun run format:check" },
	],
	multi: true,
};

/** AskQuestion list: questions in the order QuestionsForm steps through them. */
export const askQuestions: AskQuestion[] = [askScope, askChecks];

/** UiRequest: the agent's ask tool (method "askDialog"), carrying the two questions above. */
export const askUiRequest: UiRequest = {
	id: "ask_4c1",
	method: "askDialog",
	params: { questions: askQuestions },
};

// ---------------------------------------------------------------------------
// Settings modal: tabs, groups, and items across the setting types.
// ---------------------------------------------------------------------------

/** Sidebar sections under the active Model tab: SettingsNav lists them and scrolls to each. */
export const settingsModelSections: SettingsSection[] = [
	{ id: settingsSectionId("model", "Defaults"), label: "Defaults" },
	{ id: settingsSectionId("model", "Providers"), label: "Providers" },
];

/** Sidebar sections under the Web UI tab while signed in. */
export const settingsWebUiSections: SettingsSection[] = [
	{ id: settingsSectionId("web-ui", "Interface"), label: "Interface" },
	{ id: settingsSectionId("web-ui", "Session"), label: "Session" },
];

/** SettingsItem: enum with provenance, so the row shows effective/explicit/source and the layer picker. */
export const settingThinkingLevel: SettingsItem = {
	path: "defaultThinkingLevel",
	label: "Default thinking level",
	description: "Reasoning effort new sessions start with.",
	type: "enum",
	value: "high",
	changed: true,
	values: ["off", "minimal", "low", "medium", "high", "xhigh"],
	view: {
		path: "defaultThinkingLevel",
		effective: "high",
		source: "project",
		explicit: { value: "high", layer: "project" },
		canUnset: true,
		warnings: [],
		effect: "next-session",
	},
};

/** SettingsItem: changed row whose value is an explicit global write, so Reset is offered. */
export const settingThinkingLevelGlobal: SettingsItem = {
	...settingThinkingLevel,
	view: {
		...settingThinkingLevel.view!,
		source: "global",
		explicit: { value: "high", layer: "global" },
	},
};

/** SettingsItem: boolean that the daemon warns about. */
export const settingAutoCompact: SettingsItem = {
	path: "compaction.auto",
	label: "Auto-compact",
	description: "Summarize context automatically near the window limit.",
	type: "boolean",
	value: true,
	changed: false,
	view: {
		path: "compaction.auto",
		effective: true,
		source: "default",
		canUnset: false,
		warnings: ["Disabled by OMP_NO_COMPACT in the daemon environment for this run."],
		effect: "live",
	},
};

/** SettingsItem: boolean with a risk callout (the wire `warning`), as externalThinking ships it. */
export const settingExternalThinking: SettingsItem = {
	path: "externalThinking",
	label: "External Thinking",
	description:
		"Private scratchpad; not shown to user. Disables supported GPT, Claude, and Gemini reasoning",
	type: "boolean",
	value: false,
	changed: false,
	warning:
		"At your own risk: providers have flagged this request shape as abuse, up to account-level enforcement",
	view: {
		path: "externalThinking",
		effective: false,
		source: "default",
		canUnset: false,
		warnings: [],
		effect: "next-session",
	},
};

/** SettingsItem: submenu whose options carry descriptions. */
export const settingEditMode: SettingsItem = {
	path: "edit.mode",
	label: "Edit mode",
	description: "How the edit tool addresses file content.",
	type: "submenu",
	value: "hashline",
	changed: false,
	options: [
		{ value: "replace", label: "Replace", description: "Match exact old text and swap it." },
		{ value: "hashline", label: "Hashline", description: "Anchor edits to line hashes." },
		{ value: "patch", label: "Patch", description: "Apply unified diff hunks." },
	],
};

/** SettingsItem: plain text value. */
export const settingBashTimeout: SettingsItem = {
	path: "bash.timeoutSeconds",
	label: "Bash timeout (seconds)",
	description: "Kill a bash call that runs longer than this.",
	type: "text",
	value: "300",
	changed: true,
};

/** SettingsItem: secret text, rendered masked with a show toggle and a masked placeholder. */
export const settingApiKey: SettingsItem = {
	path: "providers.anthropic.apiKey",
	label: "Anthropic API key",
	description: "Stored in the daemon keychain, never sent to the browser.",
	type: "text",
	value: "sk-ant-redacted",
	changed: true,
	secret: true,
};

/** SettingsItem: ordered multiselect, so selected chips get move up/down buttons. */
export const settingEnabledTools: SettingsItem = {
	path: "tools.enabled",
	label: "Enabled tools",
	description: "Tools offered to the model, in prompt order.",
	type: "multiselect",
	value: ["read", "edit", "grep", "bash"],
	changed: true,
	ordered: true,
	options: [
		{ value: "read", label: "read" },
		{ value: "edit", label: "edit" },
		{ value: "grep", label: "grep" },
		{ value: "bash", label: "bash" },
		{ value: "browser", label: "browser" },
		{ value: "task", label: "task" },
	],
};

/** SettingsItem: per-provider spend limits, expandable into one numeric input per provider. */
export const settingProviderLimits: SettingsItem = {
	path: "providers.dailyLimitUsd",
	label: "Daily spend limit (USD)",
	description: "Stop dispatching to a provider once its daily spend passes this.",
	type: "providerLimits",
	value: { anthropic: 25, openai: 10 },
	changed: true,
	providers: ["anthropic", "openai", "google"],
};

/** SettingsItem: record edited as JSON. */
export const settingEnvRecord: SettingsItem = {
	path: "bash.env",
	label: "Bash environment",
	description: "Extra environment variables for every bash call.",
	type: "record",
	value: { CI: "1", NODE_ENV: "development" },
	changed: true,
};

/** SettingsItem: list edited as JSON. */
export const settingSkillPaths: SettingsItem = {
	path: "skills.paths",
	label: "Skill search paths",
	description: "Extra directories scanned for skills.",
	type: "list",
	value: ["~/.omp/skills", "./.omp/skills"],
	changed: false,
};

/**
 * SettingsModel: Web UI reads the appearance tab's Images group; the other tabs
 * render as client sections. Revision 42 outranks the /ctl/settings fixture
 * (revision 3), so the seeded model survives the panel's mount refresh.
 */
export const settingsModel: SettingsModel = {
	revision: 42,
	target: "future-sessions",
	tabs: [
		{
			id: "appearance",
			label: "Appearance",
			groups: [
				{
					name: "Images",
					items: [
						{
							path: "images.autoResize",
							label: "Auto-resize images",
							description: "Downscale large images to 2000px before sending them to the model.",
							type: "boolean",
							value: true,
							changed: false,
						},
						{
							path: "images.blockImages",
							label: "Block images",
							description: "Never attach images to model requests.",
							type: "boolean",
							value: false,
							changed: false,
						},
					],
				},
			],
		},
		{
			id: "model",
			label: "Model",
			groups: [
				{ name: "Defaults", items: [settingThinkingLevel, settingEditMode] },
				{ name: "Providers", items: [settingApiKey, settingProviderLimits] },
			],
		},
		{
			id: "tools",
			label: "Tools",
			groups: [
				{ name: "Execution", items: [settingBashTimeout, settingEnvRecord] },
				{ name: "Availability", items: [settingEnabledTools] },
			],
		},
		{
			id: "context",
			label: "Context",
			groups: [
				{ name: "Compaction", items: [settingAutoCompact] },
				{ name: "Skills", items: [settingSkillPaths] },
			],
		},
	],
};

/** SettingsModel for a session-attached panel: same items, current-session target. */
export const settingsModelCurrentSession: SettingsModel = {
	...settingsModel,
	target: "current-session",
};

// ---------------------------------------------------------------------------
// Model picker: the session's model, the catalog, roles, and presets.
// ---------------------------------------------------------------------------

/** Resolved anthropic-messages compat for the first-party endpoint. The showcase renders the shape only; provider behavior is not exercised. */
const firstPartyCompat: ResolvedAnthropicCompat = {
	officialEndpoint: true,
	firstPartyProvider: true,
	honorsClaudeCodeBetaKillSwitch: false,
	supportsContextManagement: true,
	supportsServerCompaction: true,
	supportsOutputEffort: true,
	disableStrictTools: false,
	disableAdaptiveThinking: false,
	supportsEagerToolInputStreaming: true,
	supportsLongCacheRetention: true,
	supportsMidConversationSystem: true,
	supportsTurnScopedSystem: true,
	supportsMidConversationToolChanges: true,
	supportsPerMessageEffort: true,
	supportsThinkingBindingControls: true,
	supportsBetweenToolsThinking: true,
	supportsForcedToolChoice: true,
	supportsSamplingParams: true,
	requiresToolResultId: false,
	allowAnthropicHeaderOverrides: false,
	replayUnsignedThinking: false,
	requiresThinkingEnabled: false,
	escapeBuiltinToolNames: false,
	signingEndpoint: false,
	injectClaudeCodeInstruction: false,
	stripImageInput: false,
};

/** Model: the session's active model (state.model), as the SDK catalog describes it. */
export const sessionModel: Model = {
	id: "claude-opus-4-1",
	name: "Claude Opus 4.1",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
	contextWindow: 200_000,
	maxTokens: 32_000,
	identity: { class: "claude", family: "opus" },
	thinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high", "xhigh"] as Effort[] },
	compat: firstPartyCompat,
};

/** ModelRoleCatalogEntry list: RoleStep rows, with project and global assignments, an unassigned role, and hidden roles. */
export const modelRoleCatalog: ModelRoleCatalogEntry[] = [
	{
		role: "default",
		name: "Default",
		hidden: false,
		provider: "anthropic",
		id: "claude-opus-4-1",
		thinkingLevel: "high",
		source: "project",
	},
	{
		role: "smol",
		name: "Smol",
		tag: "SMOL",
		hidden: false,
		provider: "anthropic",
		id: "claude-haiku-5-5",
		source: "global",
	},
	{
		role: "plan",
		name: "Plan",
		tag: "PLAN",
		hidden: false,
		provider: "openai",
		id: "gpt-5.2",
		thinkingLevel: "medium",
		source: "global",
	},
	{ role: "slow", name: "Slow", tag: "SLOW", hidden: false, source: "default" },
	{ role: "vision", name: "Vision", hidden: true, source: "default" },
	{
		role: "commit",
		name: "Commit",
		hidden: true,
		provider: "anthropic",
		id: "claude-haiku-5-5",
		source: "global",
	},
];

/** ModelInfo list: ModelStep catalog rows across providers, with and without controllable thinking. */
export const modelInfos: ModelInfo[] = [
	{
		provider: "anthropic",
		id: "claude-opus-4-1",
		contextWindow: 200_000,
		reasoning: true,
		thinking: {
			mode: "anthropic-adaptive",
			efforts: ["low", "medium", "high", "xhigh"] as Effort[],
		},
	},
	{ provider: "anthropic", id: "claude-sonnet-4", contextWindow: 200_000, reasoning: false },
	{ provider: "anthropic", id: "claude-haiku-5-5", contextWindow: 200_000, reasoning: false },
	{
		provider: "openai",
		id: "gpt-5.2",
		contextWindow: 400_000,
		reasoning: true,
		thinking: { mode: "effort", efforts: ["minimal", "low", "medium", "high"] as Effort[] },
	},
	{
		provider: "google",
		id: "gemini-3-pro",
		contextWindow: 1_048_576,
		reasoning: true,
		thinking: { mode: "google-level", efforts: ["low", "high"] as Effort[] },
	},
	{ provider: "opencode-go", id: "deepseek-v4-flash", contextWindow: 128_000, reasoning: false },
];

/** ModelPreset list: saved role bundles for ModelPicker. */
export const modelPresets: ModelPreset[] = [
	{
		name: "review-heavy",
		modelRoles: { default: "anthropic/claude-opus-4-1", smol: "anthropic/claude-haiku-5-5" },
		defaultThinkingLevel: "high",
	},
	{
		name: "budget",
		modelRoles: { default: "anthropic/claude-haiku-5-5" },
	},
];

// ---------------------------------------------------------------------------
// Resume picker: local sessions and foreign (claude or codex) previews.
// ---------------------------------------------------------------------------

/** ResumeCandidate list: ResumePicker rows, pinned first. */
export const resumeCandidates: ResumeCandidate[] = [
	{
		id: "sess_9d2c",
		sessionFile: "/home/joshua/.omp/sessions/omp-web/2026-10-09T09-40-12.jsonl",
		cwd: "/home/joshua/Repos/omp-web",
		title: "Design-system fixture modules",
		createdMs: T0 - 80 * MIN,
		modifiedMs: T0 - 2 * MIN,
		messageCount: 64,
		status: "idle",
		firstMessage: "Write the six typed fixture modules for the showcase.",
		pinned: true,
		scope: "local",
	},
	{
		id: "sess_41f0",
		sessionFile: "/home/joshua/.omp/sessions/omp-web/2026-10-08T17-12-44.jsonl",
		cwd: "/home/joshua/Repos/omp-web",
		createdMs: T0 - 17 * 60 * MIN,
		modifiedMs: T0 - 15 * MIN,
		messageCount: 9,
		firstMessage: "Why does the review panel drop orphaned annotations?",
		pinned: false,
		scope: "global",
	},
];

/** ForeignSessionPreview list: Claude and Codex sessions offered for import. */
export const foreignSessionPreviews: ForeignSessionPreview[] = [
	{
		source: "claude",
		sourceName: "Claude Code",
		id: "c1a9f0",
		path: "/home/joshua/.claude/projects/omp-web/c1a9f0.jsonl",
		cwd: "/home/joshua/Repos/omp-web",
		title: "Refactor CopyButton",
		createdMs: T0 - 3 * 24 * 60 * MIN,
		modifiedMs: T0 - 3 * 24 * 60 * MIN + 45 * MIN,
		messageCount: 22,
		firstMessage: "Extract the clipboard helper out of CopyButton.",
	},
	{
		source: "codex",
		sourceName: "Codex CLI",
		id: "cx_77b2",
		path: "/home/joshua/.codex/sessions/cx_77b2.jsonl",
		cwd: "/home/joshua/Repos/localaction",
		createdMs: T0 - 5 * 24 * 60 * MIN,
		modifiedMs: T0 - 5 * 24 * 60 * MIN + 10 * MIN,
		messageCount: 6,
		staged: true,
	},
];

// ---------------------------------------------------------------------------
// Integrations: MCP servers, skills, and plugins.
// ---------------------------------------------------------------------------

/** McpServerEntry list: McpServersDialog rows, one connected, one errored, one disabled. */
export const mcpServers: McpServerEntry[] = [
	{
		name: "filesystem",
		transport: "stdio",
		enabled: true,
		status: "connected",
		error: null,
		source: "project",
	},
	{
		name: "linear",
		transport: "http",
		enabled: true,
		status: "error",
		error: "401 Unauthorized: token expired",
		source: "profile",
	},
	{ name: "postgres", transport: "stdio", enabled: false, status: "disabled", source: "project" },
];

/** SkillEntry list: SkillsDialog rows. */
export const skillEntries: SkillEntry[] = [
	{
		id: "pdf-extract",
		source: "project",
		version: "1.2.0",
		enabled: true,
		description: "Extract text and tables from PDF attachments.",
	},
	{
		id: "changelog",
		source: "profile",
		enabled: false,
		description: "Draft CHANGELOG entries from commits.",
	},
];

/** PluginEntry list: plugin rows in SkillsDialog, extending the skill shape. */
export const pluginEntries: PluginEntry[] = [
	{
		id: "github-review",
		source: "profile",
		version: "0.9.3",
		enabled: true,
		description: "Post review comments from annotations to a pull request.",
	},
];

// ---------------------------------------------------------------------------
// Downloads: consent dialog and manifest.
// ---------------------------------------------------------------------------

/** DownloadConsent: HTML export that includes advisor notes and two subagent transcripts. */
export const downloadConsent: DownloadConsent = {
	kind: "html-themed",
	includeAdvisor: true,
	includeBtw: false,
	inclusions: ["Main transcript (64 items)", "Advisor notes (2)", "Subagent ChatMap (completed)"],
	warnings: ["Tool outputs may contain file contents from the repo."],
	provenance: {
		sessionId: "sess_9d2c",
		sessionFile: "/home/joshua/.omp/sessions/omp-web/2026-10-09T09-40-12.jsonl",
	},
	workerCount: 2,
};

/** WebDownloadManifest: the manifest that backs the consent dialog above. */
export const downloadManifest: WebDownloadManifest = {
	files: [
		{ name: "session.html", kind: "html", sessionId: "sess_9d2c", bytes: 412_880 },
		{ name: "ChatMap.jsonl", kind: "subagent", sessionId: "sess_9d2c", bytes: 58_210 },
	],
	advisorIncluded: true,
	btwIncluded: false,
	workerCount: 2,
	warnings: ["Tool outputs may contain file contents from the repo."],
	provenance: {
		sessionId: "sess_9d2c",
		sessionFile: "/home/joshua/.omp/sessions/omp-web/2026-10-09T09-40-12.jsonl",
	},
};

// ---------------------------------------------------------------------------
// BTW side conversations.
// ---------------------------------------------------------------------------

/** BtwRecordView list: BtwHistorySheet rows, one complete and one interrupted. */
export const btwRecords: BtwRecordView[] = [
	{
		id: "btw_01",
		leafId: "btw_01_a",
		question: "What does the Run key point at?",
		answer: "The id of the first tool item in the run, so it stays stable as later tools append.",
		status: "complete",
		createdAt: T0 - 30 * MIN,
		updatedAt: T0 - 29 * MIN,
	},
	{
		id: "btw_02",
		leafId: null,
		question: "Can the review panel run offline?",
		answer: "",
		status: "interrupted",
		createdAt: T0 - 10 * MIN,
		updatedAt: T0 - 9 * MIN,
		error: "connection lost mid-answer",
	},
];

// ---------------------------------------------------------------------------
// Browser UI contributions rendered by ExtensionUi.
// ---------------------------------------------------------------------------

/** BrowserUiContribution: a dialog contribution with text, code, list, and actions blocks. */
const reviewContribution: BrowserUiContribution = {
	id: "review.summary",
	kind: "dialogs",
	owner: "github-review",
	title: "Review summary",
	payload: {
		blocks: [
			{ type: "text", text: "**2** open annotations, **1** stale.", markdown: true },
			{ type: "code", code: "bun test apps/web/store/review.test.ts", language: "bash" },
			{
				type: "list",
				items: ["Group by anchor kind", "Keep orphaned notes visible"],
				ordered: true,
			},
			{
				type: "actions",
				actions: [
					{ id: "post", label: "Post to PR" },
					{ id: "dismiss", label: "Dismiss" },
				],
			},
		],
		placement: "modal",
	},
	version: 3,
};

/** BrowserUiRequest list: one request for the review contribution, scoped to the current session. */
export const browserUiRequests: BrowserUiRequest[] = [
	{
		requestId: "bui_1",
		contribution: reviewContribution,
		scope: { workspaceId: "ws_omp", sessionId: "sess_9d2c", generation: "gen_4" },
		busy: false,
		error: null,
	},
];

/** BrowserUiRequest for the same contribution after a failed action; shows the error row. */
export const browserUiRequestFailed: BrowserUiRequest = {
	requestId: "bui_2",
	contribution: reviewContribution,
	scope: undefined,
	busy: false,
	error: "dismiss handler timed out after 5s",
};

// ---------------------------------------------------------------------------
// Sessions, stats, and MCP results.
// ---------------------------------------------------------------------------

/** SessionListEntry list: SessionPicker rows, a named session, an unnamed one, and an older session in another repo. */
export const sessionListEntries: SessionListEntry[] = [
	{
		path: "/home/joshua/.omp/sessions/omp-web/2026-10-09T09-40-12.jsonl",
		id: "sess_09a41c",
		name: "Bump SDK pins to 18.9",
		cwd: "/home/joshua/Repos/omp-web",
		modifiedAt: T0 + 2 * 60 * MIN,
		messageCount: 39,
	},
	{
		path: "/home/joshua/.omp/sessions/omp-web/2026-10-08T14-10-00.jsonl",
		id: "sess_7c02be",
		name: "Fix review anchor offsets",
		cwd: "/home/joshua/Repos/omp-web",
		modifiedAt: T0 - 20 * 60 * MIN,
		messageCount: 87,
	},
	{
		path: "/home/joshua/.omp/sessions/localaction/2026-10-07T16-45-00.jsonl",
		id: "sess_4e18d3",
		cwd: "/home/joshua/Repos/localaction",
		modifiedAt: T0 - 26 * 60 * MIN,
		messageCount: 6,
	},
	{
		path: "/home/joshua/.omp/sessions/omp-web/2026-10-06T10-02-00.jsonl",
		id: "sess_b9f210",
		name: "Tune compaction thresholds",
		cwd: "/home/joshua/Repos/omp-web",
		modifiedAt: T0 - 3 * 24 * 60 * MIN,
		messageCount: 112,
	},
];

/** SessionStats: SessionStatsDialog totals for the attached session, with the context window nearly half used. */
export const sessionStatsSummary: SessionStats = {
	sessionFile: "/home/joshua/.omp/sessions/omp-web/2026-10-09T09-40-12.jsonl",
	sessionId: "sess_09a41c",
	userMessages: 6,
	assistantMessages: 14,
	toolCalls: 19,
	toolResults: 19,
	totalMessages: 39,
	tokens: {
		input: 148_302,
		output: 9_845,
		reasoning: 3_120,
		cacheRead: 1_204_566,
		cacheWrite: 61_440,
		total: 1_424_153,
	},
	premiumRequests: 0,
	cost: 3.42,
	contextUsage: { tokens: 84_310, contextWindow: 200_000, percent: 42.2 },
};

/** ContextUsageBreakdown: SessionStatsDialog's context section, anchored to the last provider response. */
export const contextBreakdown: ContextUsageBreakdown = {
	contextWindow: 200_000,
	anchored: true,
	usedTokens: 84_310,
	systemPromptTokens: 6_120,
	systemToolsTokens: 11_480,
	systemContextTokens: 2_940,
	skillsTokens: 1_860,
	messagesTokens: 61_910,
};

/** MCP test result: a successful connection check for the filesystem server. */
export const mcpTestPassed = {
	server: "filesystem",
	text: "Connected in 84 ms. 11 tools, 2 resources.",
};

/** MCP test result: a failed check for the linear server (expired token). */
export const mcpTestFailed = {
	server: "linear",
	text: "Error: 401 Unauthorized. The OAuth token has expired.",
};

/** MCP inspection: the tool list shown after inspecting a connected server. */
export const mcpInspectionTools = {
	server: "filesystem",
	kind: "tools",
	text: [
		"read_file: Read a text file. Args: path (string), offset? (number), limit? (number)",
		"write_file: Create or overwrite a file. Args: path (string), content (string)",
		"list_directory: List entries in a directory. Args: path (string)",
		"search_files: Recursive filename search. Args: root (string), pattern (string)",
	].join("\n"),
};
