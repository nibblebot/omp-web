import type { Model } from "@oh-my-pi/pi-ai";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { ResolvedAnthropicCompat } from "@oh-my-pi/pi-catalog/types";
import type { AskQuestion, UiRequest } from "../../web/prompt/ask-types";
import type { SettingsSection } from "../../web/components/settings/SettingsNav";
import { settingsSectionId } from "../../web/prefs/settings-tabs";
import type { BrowserUiRequest } from "../../web/store/browser-ui";
import type { DownloadConsent, WebDownloadManifest } from "../../web/store/downloads";
import type { ResumeCandidate } from "../../web/store/resume";
import type { BrowserUiContribution } from "#lib/wire/browser-ui-contract";
import type {
	ContextUsageBreakdown,
	SessionStats,
} from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import type {
	McpInspection,
	McpServerSummary,
	McpTestResult,
	ModelRoleCatalogEntry,
	SettingsItem,
	SettingsModel,
	SkillDetail,
	SkillSummary,
} from "#lib/wire/protocol";

export const T0 = Date.parse("2026-10-09T10:00:00Z");
const MIN = 60_000;

// ---------------------------------------------------------------------------
// Ask dialog: the questions a model asks the operator.
// ---------------------------------------------------------------------------

/** AskBar: single-choice question with a recommended option and per-option previews. */
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

/** AskBar: multi-select question for which checks to run before the commit. */
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

/** AskQuestion list: questions in the order AskBar steps through them. */
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

/** Sidebar sections under the Appearance (client) tab while signed in. */
export const settingsWebUiSections: SettingsSection[] = [
	{ id: settingsSectionId("web-ui", "Interface"), label: "Interface" },
	{ id: settingsSectionId("web-ui", "Account"), label: "Account" },
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
		warnings: ["Disabled by OMP_NO_COMPACT in the session process environment for this run."],
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
	description: "Stored in the session process keychain, never sent to the browser.",
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

/** ModelRoleCatalogEntry list: role rows with project and global assignments, an unassigned role, and hidden roles. */
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

type ModelInfo = Pick<Model, "provider" | "id" | "contextWindow" | "reasoning" | "thinking">;

/** ModelInfo list: catalog rows across providers, with and without controllable thinking. */
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

// ---------------------------------------------------------------------------
// Resume picker: local sessions.
// ---------------------------------------------------------------------------

/** ResumeCandidate list: SessionPicker rows, pinned first. */
export const resumeCandidates: ResumeCandidate[] = [
	{
		id: "sess_9d2c",
		sessionFile: "/home/joshua/.omp/sessions/omp-web/2026-10-09T09-40-12.jsonl",
		cwd: "/home/joshua/Repos/omp-web",
		title: "Design-system fixture modules",
		createdMs: T0 - 80 * MIN,
		modifiedMs: T0 - 2 * MIN,
		messageCount: 64,
		status: "complete",
		firstMessage: "Write the six typed fixture modules for the showcase.",
		recentText:
			"Pinned the design-system fixtures; the showcase renders every overlay from typed modules.",
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

/** resumeList reply for the picker stories: candidates, pins, and the local session dir. */
export const resumeListReply = {
	candidates: resumeCandidates,
	pinnedIds: ["sess_9d2c"],
	sessionDir: "/home/joshua/.omp/sessions/omp-web",
	total: resumeCandidates.length,
	allProjects: false,
};

// ---------------------------------------------------------------------------
// Integrations: MCP servers, skills, and plugins.
// ---------------------------------------------------------------------------

/** McpServerSummary list: one connected, one errored (OAuth), one disabled, one discovered from another tool (read-only). */
export const mcpServers: McpServerSummary[] = [
	{
		name: "filesystem",
		transport: "stdio",
		status: "connected",
		enabled: true,
		scope: "project",
		writable: true,
		command: "npx",
		args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
		envKeys: [],
		auth: "none",
		toolCount: 14,
		toggleFile: "/repo/.omp/mcp.json",
	},
	{
		name: "linear",
		transport: "http",
		status: "disconnected",
		enabled: true,
		scope: "user",
		writable: true,
		url: "https://mcp.linear.app/mcp",
		headerNames: [],
		auth: "oauth",
		error: "401 Unauthorized: token expired",
		toggleFile: "/home/dev/.config/omp/mcp.json",
	},
	{
		name: "postgres",
		transport: "stdio",
		status: "disabled",
		enabled: false,
		scope: "project",
		writable: true,
		command: "uvx",
		args: ["mcp-server-postgres"],
		envKeys: ["DATABASE_URL"],
		auth: "none",
		toggleFile: "/repo/.omp/mcp.json",
	},
	{
		name: "github",
		transport: "http",
		status: "connected",
		enabled: true,
		scope: "discovered",
		source: "Claude Code",
		writable: false,
		url: "https://api.githubcopilot.com/mcp/",
		headerNames: ["Authorization"],
		auth: "token",
		toolCount: 3,
		toggleFile: "/home/dev/.config/omp/mcp.json",
	},
];

/** SkillSummary list: one enabled, one disabled and hidden from the listing. */
export const skillEntries: SkillSummary[] = [
	{
		name: "pdf-extract",
		description: "Extract text and tables from PDF attachments.",
		source: "OMP (project)",
		path: "/repo/.omp/skills/pdf-extract/SKILL.md",
		enabled: true,
		hidden: false,
	},
	{
		name: "changelog",
		description: "Draft CHANGELOG entries from commits.",
		source: "Agents (user)",
		path: "/home/dev/.agents/skills/changelog/SKILL.md",
		enabled: false,
		hidden: true,
	},
];

/** getSkillDetail answers keyed by skill name: the summary plus its SKILL.md body, alwaysApply, and globs. */
export const skillDetails: Record<string, SkillDetail> = {
	"pdf-extract": {
		...skillEntries[0],
		alwaysApply: false,
		globs: ["**/*.pdf"],
		body: [
			"# PDF extract",
			"",
			"Use this skill when the user attaches a PDF and asks for its text or tables.",
			"",
			"## Steps",
			"",
			"1. Run `pdftotext -layout <file> -` to get the text.",
			"2. For tables, run `pdfplumber` and print each table as markdown.",
			"3. Summarize what you found before quoting long passages.",
			"",
			"```sh",
			"pdftotext -layout report.pdf - | head -n 40",
			"```",
			"",
			"Untrusted content check: <script>alert(1)</script> never runs here.",
		].join("\n"),
	},
	changelog: {
		...skillEntries[1],
		alwaysApply: true,
		globs: [],
		body: "Draft a CHANGELOG entry from the commits since the last tag. Group them under Added, Changed, and Fixed.",
	},
};

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
export const mcpTestPassed: { server: string; result: McpTestResult } = {
	server: "filesystem",
	result: {
		ok: true,
		detail: "Connected in 84 ms.",
		tools: ["read_file", "write_file", "list_directory"],
	},
};

/** MCP test result: a failed check for the linear server (expired token). */
export const mcpTestFailed: { server: string; result: McpTestResult } = {
	server: "linear",
	result: { ok: false, detail: "Error: 401 Unauthorized. The OAuth token has expired.", tools: [] },
};

/** The filesystem server's tools: first ten of fourteen show before "Show all". */
const filesystemTools: McpInspection["tools"] = [
	{
		name: "read_file",
		title: "Read file",
		description: "Read a text file.",
		parameters: [
			{ name: "path", type: "string", required: true, description: "File to read." },
			{ name: "head", type: "number", required: false, description: "Only the first N lines." },
		],
	},
	{
		name: "write_file",
		title: "Write file",
		description: "Create or overwrite a file.",
		parameters: [
			{ name: "path", type: "string", required: true },
			{ name: "content", type: "string", required: true },
		],
	},
	{
		name: "list_directory",
		description: "List entries in a directory.",
		parameters: [{ name: "path", type: "string", required: true }],
	},
	{
		name: "search_files",
		description: "Recursive filename search.",
		parameters: [
			{ name: "path", type: "string", required: true },
			{ name: "pattern", type: "string", required: true },
			{ name: "excludePatterns", type: "array", required: false },
		],
	},
	...[
		"edit_file",
		"create_directory",
		"move_file",
		"get_file_info",
		"directory_tree",
		"read_multiple_files",
		"list_allowed_directories",
		"read_media_file",
		"delete_file",
		"copy_file",
	].map((name) => ({
		name,
		description: `The ${name.replaceAll("_", " ")} tool.`,
		parameters: [{ name: "path", type: "string", required: true }],
	})),
];

/** MCP inspection: what a connected server reports (implementation, tools with parameters, a resource, a prompt). */
export const mcpInspectionTools: { server: string; inspection: McpInspection } = {
	server: "filesystem",
	inspection: {
		server: { name: "secure-filesystem-server", version: "0.2.0" },
		tools: filesystemTools,
		resources: [
			{
				uri: "file:///repo/README.md",
				name: "README",
				description: "Project readme exposed as a resource.",
			},
		],
		prompts: [{ name: "summarize_directory", description: "Summarize a directory tree." }],
	},
};

/** MCP inspection with only a few tools: no "Show all" button. */
export const mcpInspectionFewTools: { server: string; inspection: McpInspection } = {
	server: "github",
	inspection: {
		server: { name: "github-mcp-server" },
		tools: filesystemTools.slice(0, 3),
		resources: [],
		prompts: [],
	},
};
