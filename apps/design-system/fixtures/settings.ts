import type {
	SettingsItem,
	SettingsModel,
	SettingsTab,
	SettingValues,
	SettingView,
} from "#lib/wire/protocol";
import type { CallHandlers } from "../session";

/**
 * A session's settings model across every SDK tab, as `getSettings` answers it: the rows and
 * option lists the SDK ships (`buildSettingsModel`, default values), cut down to a few rows per
 * group. It covers every `BOOT_SETTING_PATHS` entry, so an attach's `getSettings({ paths })`
 * read finds each value here too.
 */

type Row = Omit<SettingsItem, "changed" | "view">;

/** A row at its default; `effect` says when an edit applies, as the SDK's row view does. */
function row(item: Row, effect: SettingView["effect"]): SettingsItem {
	return {
		...item,
		changed: false,
		view: {
			path: item.path,
			effective: item.value,
			source: "default",
			canUnset: false,
			warnings: [],
			effect,
		},
	};
}

const live = (item: Row): SettingsItem => row(item, "live");
const nextSession = (item: Row): SettingsItem => row(item, "next-session");

const sessionSettingsTabs: SettingsTab[] = [
	{
		id: "appearance",
		label: "Appearance",
		groups: [
			{
				name: "Display",
				items: [
					live({
						path: "tui.renderMermaid",
						label: "Render Mermaid Diagrams",
						description: "Render Mermaid fenced code blocks as ASCII diagrams",
						value: true,
						type: "boolean",
					}),
					live({
						path: "display.shimmer",
						label: "Shimmer",
						description: "Animation style for working/loading messages",
						value: "classic",
						type: "submenu",
						options: [
							{
								value: "classic",
								label: "Classic",
								description: "Soft cosine wave sweeping across the text",
							},
							{
								value: "kitt",
								label: "KITT Scanner",
								description: "Knight Rider 1982 red light bouncing left-right",
							},
							{
								value: "disabled",
								label: "Disabled",
								description: "No animation; static muted text",
							},
						],
					}),
					live({
						path: "display.subagentLivePreview",
						label: "Subagent Live Preview",
						description:
							"Show each pinned subagent's current (or most recent) tool call beneath its row",
						value: false,
						type: "boolean",
					}),
					live({
						path: "display.smoothStreaming",
						label: "Smooth Streaming",
						description:
							"Reveal assistant text and streamed tool input smoothly while chunks arrive",
						value: true,
						type: "boolean",
					}),
					live({
						path: "display.hideToolActivity",
						label: "Hide Tool Activity",
						description: "Hide model-initiated tool calls and results from the transcript",
						value: false,
						type: "boolean",
					}),
					live({
						path: "display.showTokenUsage",
						label: "Show Token Usage",
						description: "Show per-turn token usage on assistant messages",
						value: false,
						type: "boolean",
					}),
					live({
						path: "display.showTurnTime",
						label: "Show Turn Time",
						description:
							"Show the total prompt-to-yield time (including tool calls) on assistant message usage rows",
						value: false,
						type: "boolean",
					}),
					live({
						path: "display.cacheMissMarker",
						label: "Cache Miss Marker",
						description:
							"Show a divider after an assistant turn whose request lost (missed) the prompt cache",
						value: false,
						type: "boolean",
					}),
					live({
						path: "title.icons",
						label: "Title Icons",
						description: "Icon and short code that head new generated or /rename session titles",
						value: "nf+emoji",
						type: "submenu",
						options: [
							{
								value: "nf+emoji",
								label: "Nerd Font + Emoji",
								description:
									"Nerd Font glyph where the Nerd Font symbol preset renders it, else the emoji (default)",
							},
							{ value: "emoji", label: "Emoji", description: "Always the emoji" },
							{ value: "boring", label: "Boring", description: "Plain title: no icon or code" },
						],
					}),
				],
			},
			{
				name: "Images",
				items: [
					live({
						path: "terminal.showImages",
						label: "Show Inline Images",
						description: "Render images inline in the terminal",
						value: true,
						type: "boolean",
					}),
					live({
						path: "images.autoResize",
						label: "Auto-Resize Images",
						description: "Resize large images to 2000x2000 max for better model compatibility",
						value: true,
						type: "boolean",
					}),
					live({
						path: "images.blockImages",
						label: "Block Images",
						description: "Prevent images from being sent to LLM providers",
						value: false,
						type: "boolean",
					}),
				],
			},
		],
	},
	{
		id: "model",
		label: "Model",
		groups: [
			{
				name: "Thinking",
				items: [
					nextSession({
						path: "defaultThinkingLevel",
						label: "Thinking Level",
						description: "Reasoning depth for thinking-capable models",
						value: "high",
						type: "submenu",
						options: [
							{ value: "auto", label: "auto" },
							{ value: "off", label: "off" },
							{ value: "minimal", label: "min", description: "Very brief reasoning (~1k tokens)" },
							{ value: "low", label: "low", description: "Light reasoning (~2k tokens)" },
							{ value: "medium", label: "medium", description: "Moderate reasoning (~8k tokens)" },
							{ value: "high", label: "high", description: "Deep reasoning (~16k tokens)" },
							{ value: "xhigh", label: "xhigh", description: "Extended reasoning (~32k tokens)" },
						],
					}),
					live({
						path: "hideThinkingBlock",
						label: "Hide Thinking Blocks",
						description: "Hide thinking blocks in assistant responses",
						value: false,
						type: "boolean",
					}),
					live({
						path: "expandThinkingBlocks",
						label: "Expand Thinking Blocks",
						description:
							"Keep finished thinking blocks expanded instead of collapsing them when the turn ends",
						value: false,
						type: "boolean",
					}),
					live({
						path: "proseOnlyThinking",
						label: "Prose Only Thinking",
						description:
							"Omit code blocks from thinking summaries and replace them with an ellipsis",
						value: true,
						type: "boolean",
					}),
				],
			},
			{
				name: "Sampling",
				items: [
					live({
						path: "temperature",
						label: "Temperature",
						description:
							"Sampling temperature (0 = deterministic, 1 = creative, -1 = provider default)",
						value: -1,
						type: "submenu",
						options: [
							{ value: "-1", label: "Default", description: "Use provider default" },
							{ value: "0", label: "0", description: "Deterministic" },
							{ value: "0.2", label: "0.2", description: "Focused" },
							{ value: "0.5", label: "0.5", description: "Balanced" },
							{ value: "0.7", label: "0.7", description: "Creative" },
							{ value: "1", label: "1", description: "Maximum variety" },
						],
					}),
				],
			},
			{
				name: "Prompt",
				items: [
					live({
						path: "includeModelInPrompt",
						label: "Include Model in Prompt",
						description:
							"Surface the active model identifier in the system prompt so the agent knows which model it is",
						value: true,
						type: "boolean",
					}),
				],
			},
			{
				name: "Retry & Fallback",
				items: [
					live({
						path: "retry.maxRetries",
						label: "Retry Attempts",
						description: "Maximum retry attempts on API errors",
						value: 10,
						type: "submenu",
						options: [
							{ value: "1", label: "1 retry" },
							{ value: "2", label: "2 retries" },
							{ value: "3", label: "3 retries" },
							{ value: "5", label: "5 retries" },
							{ value: "10", label: "10 retries" },
						],
					}),
					live({
						path: "retry.modelFallback",
						label: "Retry Model Fallback",
						description:
							"Allow retry recovery to switch to models in retry.fallbackChains after provider errors. Independent of Auto-Promote Context",
						value: true,
						type: "boolean",
					}),
				],
			},
			{
				name: "Advisor",
				items: [
					live({
						path: "advisor.enabled",
						label: "Enable Advisor",
						description:
							"Pair a second model (assigned to the 'advisor' role) that passively reviews each turn and injects notes.",
						value: false,
						type: "boolean",
					}),
				],
			},
		],
	},
	{
		id: "interaction",
		label: "Interaction",
		groups: [
			{
				name: "Input",
				items: [
					live({
						path: "steeringMode",
						label: "Steering Mode",
						description: "How to process queued messages while agent is working",
						value: "one-at-a-time",
						type: "enum",
						values: ["all", "one-at-a-time"],
					}),
					live({
						path: "followUpMode",
						label: "Follow-Up Mode",
						description: "How to drain follow-up messages after a turn completes",
						value: "one-at-a-time",
						type: "enum",
						values: ["all", "one-at-a-time"],
					}),
					live({
						path: "interruptMode",
						label: "Interrupt Mode",
						description: "When steering messages interrupt tool execution",
						value: "immediate",
						type: "enum",
						values: ["immediate", "wait"],
					}),
					live({
						path: "autocompleteMaxVisible",
						label: "Autocomplete Items",
						description: "Max visible items in autocomplete dropdown (3-20)",
						value: 10,
						type: "submenu",
						options: [
							{ value: "3", label: "3 items" },
							{ value: "5", label: "5 items" },
							{ value: "7", label: "7 items" },
							{ value: "10", label: "10 items" },
							{ value: "15", label: "15 items" },
							{ value: "20", label: "20 items" },
						],
					}),
					live({
						path: "spelling.autocomplete",
						label: "Word Autocomplete",
						description:
							"Show predicted word completions as inline hints: Tab accepts with a space, Right without",
						value: "auto",
						type: "submenu",
						options: [
							{ value: "off", label: "Off", description: "No word completion" },
							{ value: "auto", label: "Auto", description: "N-gram (nothing to download)" },
							{
								value: "ngram",
								label: "N-gram",
								description: "Learns your vocabulary from prompt history",
							},
							{
								value: "smollm",
								label: "SmolLM",
								description:
									"Small on-device language model blended with N-gram (downloads weights on first use)",
							},
						],
					}),
					live({
						path: "composer.predictions",
						label: "Composer Predictions",
						description:
							"After a completed turn, ask the active model to predict your next message and show it as ghost text in the empty composer; Tab or Right inserts it without sending. Extra usage: every completed turn sends one more billed request over the whole conversation (counted in /stats)",
						value: false,
						type: "boolean",
					}),
					live({
						path: "emojiAutocomplete",
						label: "Emoji Autocomplete",
						description:
							"Suggest emojis from `:name:` shortcodes and expand text emoticons like `:D` or `:-)`",
						value: true,
						type: "boolean",
					}),
					live({
						path: "paste.largeMenuThreshold",
						label: "Large Paste Menu",
						description:
							"When a paste reaches this many lines, offer a menu to wrap it in a code block, wrap it in XML tags, or save it to a file. 0 disables the menu (large pastes still collapse to a [Paste] marker).",
						value: 100,
						type: "submenu",
						options: [
							{ value: "0", label: "Off" },
							{ value: "100", label: "100 lines" },
							{ value: "250", label: "250 lines" },
							{ value: "500", label: "500 lines" },
							{ value: "1000", label: "1000 lines" },
						],
					}),
				],
			},
			{
				name: "Notifications",
				items: [
					live({
						path: "completion.notify",
						label: "Completion Notification",
						description: "Notify when the agent finishes a turn",
						value: "on",
						type: "enum",
						values: ["on", "off"],
					}),
					live({
						path: "error.notify",
						label: "Error Notification",
						description: "Notify when the agent stops with an error",
						value: "off",
						type: "enum",
						values: ["on", "off"],
					}),
					live({
						path: "ask.notify",
						label: "Ask Notification",
						description: "Notify when the ask tool is waiting for input",
						value: "on",
						type: "enum",
						values: ["on", "off"],
					}),
				],
			},
			{
				name: "Collab",
				items: [
					live({
						path: "collab.relayUrl",
						label: "Relay URL",
						description: "Relay used by /collab (wss://host[:port])",
						value: "wss://my.omp.sh",
						type: "text",
						secret: false,
					}),
				],
			},
			{
				name: "Magic Keywords",
				items: [
					live({
						path: "magicKeywords.enabled",
						label: "Magic Keywords",
						description:
							"Enable hidden notices for standalone ultrathink, orchestrate, workflowz, jevify keywords",
						value: true,
						type: "boolean",
					}),
					live({
						path: "magicKeywords.ultrathink",
						label: "Ultrathink Keyword",
						description:
							"Let standalone ultrathink request maximum automatic thinking and append its hidden notice",
						value: true,
						type: "boolean",
					}),
					live({
						path: "magicKeywords.orchestrate",
						label: "Orchestrate Keyword",
						description:
							"Let standalone orchestrate append its hidden multi-agent orchestration notice",
						value: true,
						type: "boolean",
					}),
					live({
						path: "magicKeywords.workflow",
						label: "Workflow Keyword",
						description: "Let standalone workflowz append its hidden eval workflow notice",
						value: true,
						type: "boolean",
					}),
					live({
						path: "magicKeywords.jevify",
						label: "Jevify Keyword",
						description: "Let standalone jevify append its hidden bulk-judge classification notice",
						value: true,
						type: "boolean",
					}),
				],
			},
		],
	},
	{
		id: "context",
		label: "Context",
		groups: [
			{
				name: "General",
				items: [
					nextSession({
						path: "contextFiles.extra",
						label: "Extra Context Files",
						description:
							'Extra instruction filenames loaded beside AGENTS.md. Use a JSON list of names, not paths, e.g. ["AGENTS.local.md"]; [] disables extras. Start a new session to load them.',
						value: [],
						type: "list",
					}),
				],
			},
			{
				name: "Compaction",
				items: [
					live({
						path: "compaction.enabled",
						label: "Auto-Compact",
						description: "Automatically compact context when it gets too large",
						value: true,
						type: "boolean",
					}),
					live({
						path: "compaction.methodOrder",
						label: "Compaction Method Order",
						description:
							"Preferred fallback order for automatic context maintenance; unavailable or failed methods advance to the next choice",
						value: ["remote", "snapcompact", "handoff", "shake", "soft"],
						type: "multiselect",
						options: [
							{
								value: "remote",
								label: "Server compaction",
								description:
									"Use provider-native server compaction (OpenAI Responses compact, Anthropic compaction beta, including on Bedrock) when the active route supports it",
							},
							{
								value: "snapcompact",
								label: "Snapcompact",
								description:
									"Archive history onto dense bitmap images the active vision model reads back; no LLM call",
							},
							{
								value: "handoff",
								label: "Handoff",
								description:
									"Generate a handoff document and continue from it as the compaction summary",
							},
							{
								value: "soft",
								label: "Soft compaction",
								description:
									"Summarize in place with a compaction model without using server compaction",
							},
							{
								value: "shake",
								label: "Shake",
								description: "Drop recoverable heavy content in place without an LLM call",
							},
						],
						ordered: true,
					}),
					live({
						path: "compaction.thresholdPercent",
						label: "Compaction Threshold",
						description:
							"Percent threshold for context maintenance; set to Default to use legacy reserve-based behavior",
						value: -1,
						type: "submenu",
						options: [
							{ value: "default", label: "Default", description: "Legacy reserve-based threshold" },
							{ value: "10", label: "10%", description: "Extremely early maintenance" },
							{ value: "20", label: "20%", description: "Very early maintenance" },
							{ value: "30", label: "30%", description: "Early maintenance" },
							{ value: "40", label: "40%", description: "Moderately early maintenance" },
							{ value: "50", label: "50%", description: "Halfway point" },
							{ value: "60", label: "60%", description: "Moderate context usage" },
							{ value: "70", label: "70%", description: "Balanced" },
							{ value: "75", label: "75%", description: "Slightly aggressive" },
							{ value: "80", label: "80%", description: "Typical threshold" },
							{ value: "85", label: "85%", description: "Aggressive context usage" },
							{ value: "90", label: "90%", description: "Very aggressive" },
							{ value: "95", label: "95%", description: "Near context limit" },
						],
					}),
				],
			},
			{
				name: "Rules (TTSR)",
				items: [
					live({
						path: "ttsr.enabled",
						label: "TTSR",
						description:
							"Interrupt the agent mid-stream when output matches rule patterns (Time-Traveling Stream Rules)",
						value: true,
						type: "boolean",
					}),
				],
			},
		],
	},
	{
		id: "memory",
		label: "Memory",
		groups: [
			{
				name: "General",
				items: [
					live({
						path: "memory.backend",
						label: "Memory Backend",
						description:
							"Off, local summary pipeline, Mnemopi SQLite, Hindsight remote memory, or Sharpshooter",
						value: "off",
						type: "submenu",
						options: [
							{ value: "off", label: "Off", description: "No memory subsystem runs" },
							{
								value: "local",
								label: "Local",
								description: "Local rollout summarisation pipeline (memory_summary.md)",
							},
							{
								value: "hindsight",
								label: "Hindsight",
								description: "Vectorize Hindsight remote memory service",
							},
							{
								value: "mnemopi",
								label: "Mnemopi",
								description: "Local SQLite recall/retain backend with optional embeddings",
							},
							{
								value: "sharpshooter",
								label: "Sharpshooter",
								description:
									"Friction-gated project decision files (architecture/product/style), consolidated in the background",
							},
						],
					}),
				],
			},
			{
				name: "Auto-Learn",
				items: [
					live({
						path: "autolearn.enabled",
						label: "Auto-Learn (experimental)",
						description:
							"After the agent stops, nudge it to capture lessons to memory and create/enhance isolated managed skills",
						value: false,
						type: "boolean",
					}),
				],
			},
		],
	},
	{
		id: "files",
		label: "Files",
		groups: [
			{
				name: "Editing",
				items: [
					live({
						path: "edit.mode",
						label: "Edit Mode",
						description: "Select the edit tool variant (replace, patch, hashline, or apply_patch)",
						value: "hashline",
						type: "enum",
						values: ["apply_patch", "hashline", "patch", "replace", "sloppy"],
					}),
					live({
						path: "edit.fuzzyMatch",
						label: "Fuzzy Match",
						description: "Accept high-confidence fuzzy matches for whitespace differences",
						value: true,
						type: "boolean",
					}),
				],
			},
			{
				name: "Reading",
				items: [
					live({
						path: "readLineNumbers",
						label: "Line Numbers",
						description: "Prepend line numbers to read tool output by default",
						value: false,
						type: "boolean",
					}),
					live({
						path: "read.renderMarkdown",
						label: "Markdown Previews",
						description:
							"Render Markdown read results as formatted terminal Markdown previews instead of raw source",
						value: false,
						type: "boolean",
					}),
					live({
						path: "read.toolResultPreview",
						label: "Inline Read Previews",
						description:
							"Render read tool results inline in the transcript instead of summary rows",
						value: false,
						type: "boolean",
					}),
				],
			},
			{
				name: "LSP",
				items: [
					live({
						path: "lsp.enabled",
						label: "LSP",
						description:
							"Language-server integration: the lsp tool, diagnostics on write/edit, and format on write (--no-lsp disables for the run)",
						value: true,
						type: "boolean",
					}),
					live({
						path: "lsp.formatOnWrite",
						label: "Format on Write",
						description: "Automatically format code files using LSP after writing",
						value: false,
						type: "boolean",
					}),
				],
			},
		],
	},
	{
		id: "shell",
		label: "Shell",
		groups: [
			{
				name: "Bash",
				items: [
					live({
						path: "bash.enabled",
						label: "Bash",
						description: "Enable the bash tool for shell command execution",
						value: true,
						type: "boolean",
					}),
					live({
						path: "bash.autoBackground.enabled",
						label: "Bash Auto-Background",
						description:
							"Automatically background long-running bash commands and deliver the result later",
						value: true,
						type: "boolean",
					}),
					live({
						path: "bash.direnv",
						label: "direnv Auto-Load",
						description:
							"Auto-load a repo's direnv/devenv `.envrc` into the bash session so devenv tools and env vars are present without manual `direnv exec`. Honors direnv's allow list: an `.envrc` you haven't `direnv allow`ed is never executed",
						value: "auto",
						type: "enum",
						values: ["auto", "off"],
					}),
				],
			},
			{
				name: "Eval & Runtimes",
				items: [
					live({
						path: "eval.py",
						label: "Python Eval Backend",
						description: "Allow the eval tool to dispatch Python cells to the IPython kernel",
						value: true,
						type: "boolean",
					}),
					live({
						path: "eval.js",
						label: "JavaScript Eval Backend",
						description:
							"Allow the eval tool to dispatch JavaScript cells to the in-process runtime",
						value: true,
						type: "boolean",
					}),
				],
			},
		],
	},
	{
		id: "tools",
		label: "Tools",
		groups: [
			{
				name: "Available Tools",
				items: [
					live({
						path: "todo.enabled",
						label: "Todos",
						description: "Enable the todo tool for task tracking",
						value: true,
						type: "boolean",
					}),
					live({
						path: "glob.enabled",
						label: "Glob",
						description: "Enable the glob tool for glob-based file lookup",
						value: true,
						type: "boolean",
					}),
					live({
						path: "grep.enabled",
						label: "Grep",
						description: "Enable the grep tool for regex content search",
						value: true,
						type: "boolean",
					}),
				],
			},
			{
				name: "Execution",
				items: [
					live({
						path: "tools.intentTracing",
						label: "Intent Tracing",
						description:
							"Ask the agent to describe the intent of each tool call before executing it",
						value: true,
						type: "boolean",
					}),
				],
			},
			{
				name: "Discovery & MCP",
				items: [
					live({
						path: "mcp.enableProjectConfig",
						label: "MCP Project Config",
						description: "Load .mcp.json/mcp.json from project root",
						value: true,
						type: "boolean",
					}),
					live({
						path: "mcp.renderMarkdownResults",
						label: "MCP Markdown Results",
						description: "Render non-JSON MCP text results as Markdown in the transcript",
						value: true,
						type: "boolean",
					}),
				],
			},
		],
	},
	{
		id: "tasks",
		label: "Tasks",
		groups: [
			{
				name: "Modes",
				items: [
					live({
						path: "plan.enabled",
						label: "Plan Mode",
						description: "Enable plan mode for read-only exploration and planning before execution",
						value: true,
						type: "boolean",
					}),
					live({
						path: "goal.enabled",
						label: "Goal Mode",
						description: "Enable per-session goal mode and the hidden goal tool",
						value: true,
						type: "boolean",
					}),
				],
			},
			{
				name: "Subagents",
				items: [
					live({
						path: "task.maxConcurrency",
						label: "Max Concurrent Tasks",
						description: "Maximum number of subagents running concurrently",
						value: 32,
						type: "submenu",
						options: [
							{ value: "0", label: "Unlimited" },
							{ value: "1", label: "1 task" },
							{ value: "2", label: "2 tasks" },
							{ value: "4", label: "4 tasks" },
							{ value: "8", label: "8 tasks" },
							{ value: "16", label: "16 tasks" },
							{ value: "32", label: "32 tasks" },
							{ value: "64", label: "64 tasks" },
						],
					}),
				],
			},
			{
				name: "Isolation",
				items: [
					live({
						path: "task.isolation.enabled",
						label: "Allow Isolated Subagents",
						description:
							"Allow per-task isolation with `isolated: true`; tasks without it run in the shared checkout",
						value: false,
						type: "boolean",
					}),
				],
			},
			{
				name: "Commands & Skills",
				items: [
					live({
						path: "skills.enableSkillCommands",
						label: "Skill Commands",
						description: "Register skills as /skill:name commands",
						value: true,
						type: "boolean",
					}),
				],
			},
		],
	},
	{
		id: "providers",
		label: "Providers",
		groups: [
			{
				name: "Services",
				items: [
					live({
						path: "providers.maxInFlightRequests",
						label: "Max In-Flight Requests",
						description:
							'Maximum concurrent LLM requests per provider id (for example "openai" or "anthropic"), shared across local OMP processes with this config root. Omitted providers are unlimited.',
						value: {},
						type: "providerLimits",
						providers: ["anthropic", "google", "openai"],
					}),
					live({
						path: "providers.webSearchTimeoutSeconds",
						label: "Web Search Timeout",
						description:
							"Hard timeout for each provider's search transport before web_search advances to the next fallback, in seconds (maximum 300)",
						value: 60,
						type: "submenu",
						options: [
							{ value: "30", label: "30 seconds" },
							{ value: "60", label: "1 minute" },
							{ value: "120", label: "2 minutes" },
							{ value: "180", label: "3 minutes" },
							{ value: "300", label: "5 minutes" },
						],
					}),
				],
			},
			{
				name: "Protocol",
				items: [
					live({
						path: "providers.cacheRetention",
						label: "Prompt Cache Retention",
						description:
							"Prompt-cache retention forwarded to providers that support it (Anthropic, Bedrock, OpenRouter, OpenAI)",
						value: "auto",
						type: "submenu",
						options: [
							{
								value: "auto",
								label: "Auto",
								description:
									"Provider default — Anthropic OAuth subscriber sessions default to 1h, API keys use 5m; PI_CACHE_RETENTION still applies",
							},
							{
								value: "short",
								label: "Short (5m)",
								description:
									"Cheapest cache writes; pair with cache warming to keep short entries alive while idle",
							},
							{
								value: "long",
								label: "Long (1h+)",
								description:
									"Longer TTL where supported (Anthropic/Bedrock 1h, OpenAI GPT-5.6+ Responses 12h); pricier writes, only warmed during active runs",
							},
							{
								value: "none",
								label: "Off",
								description: "Disable prompt caching and cache-affinity routing",
							},
						],
					}),
				],
			},
			{
				name: "Privacy",
				items: [
					nextSession({
						path: "telemetry.otlpExportEnabled",
						label: "OTLP Telemetry Export",
						description:
							"Allow OMP to export traces, logs, and metrics using OTEL_* endpoints. Changes take effect on the next launch.",
						value: true,
						type: "boolean",
					}),
				],
			},
		],
	},
];

/** A fresh copy of the session settings model at revision 1. */
export function sessionSettingsModel(): SettingsModel {
	return { revision: 1, target: "current-session", tabs: structuredClone(sessionSettingsTabs) };
}

function itemsOf(model: SettingsModel): SettingsItem[] {
	return model.tabs.flatMap((tab) => tab.groups.flatMap((group) => group.items));
}

/**
 * `getSettings` and the write calls over one in-memory model, so a write sticks the way a live
 * session's does: it acks a newer revision and the client's refetch returns the new value. A
 * `{ paths }` read answers just those values. Unset restores the value the row started with.
 */
export function settingsCalls(initial: SettingsModel): CallHandlers {
	let model = initial;
	const defaults = new Map(itemsOf(initial).map((item) => [item.path, item.value]));
	const write = (path: string, value: unknown) => {
		const next = structuredClone(model);
		for (const item of itemsOf(next)) {
			if (item.path !== path) continue;
			item.value = value;
			item.changed = JSON.stringify(value) !== JSON.stringify(defaults.get(path));
			if (item.view) item.view = { ...item.view, effective: value };
		}
		model = { ...next, revision: (model.revision ?? 0) + 1 };
		return { revision: model.revision };
	};
	return {
		getSettings: (args) => {
			const paths = (args[0] as { paths?: unknown } | undefined)?.paths;
			if (!Array.isArray(paths)) return model;
			const items = new Map(itemsOf(model).map((item) => [item.path, item.value]));
			const values: Record<string, unknown> = {};
			for (const path of paths) if (items.has(path)) values[path] = items.get(path);
			return {
				revision: model.revision ?? 0,
				target: model.target ?? "current-session",
				values,
			} satisfies SettingValues;
		},
		setSetting: (args) => write(String(args[0]), args[1]),
		unsetSetting: (args) => write(String(args[0]), defaults.get(String(args[0]))),
	};
}
