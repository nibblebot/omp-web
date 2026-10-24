/** Tool name → header category (color token) and icon key for tool cards. Components map the icon key to a vendored Lucide icon. */

/** Category colors live in styles/tokens.css as `--tool-<category>`. */
export type ToolCategory = "shell" | "read" | "write" | "search" | "agents" | "other";

export type ToolIconKey =
	| "terminal"
	| "code"
	| "file-text"
	| "pencil"
	| "search"
	| "globe"
	| "braces"
	| "bot"
	| "messages-square"
	| "message-circle-question"
	| "list-checks"
	| "plug"
	| "wrench";

export interface ToolKind {
	category: ToolCategory;
	icon: ToolIconKey;
}

const KINDS: Record<string, ToolKind> = {
	bash: { category: "shell", icon: "terminal" },
	eval: { category: "shell", icon: "code" },
	read: { category: "read", icon: "file-text" },
	edit: { category: "write", icon: "pencil" },
	write: { category: "write", icon: "pencil" },
	apply_patch: { category: "write", icon: "pencil" },
	patch: { category: "write", icon: "pencil" },
	hashline: { category: "write", icon: "pencil" },
	grep: { category: "search", icon: "search" },
	glob: { category: "search", icon: "search" },
	web_search: { category: "search", icon: "globe" },
	lsp: { category: "search", icon: "braces" },
	task: { category: "agents", icon: "bot" },
	wait: { category: "agents", icon: "messages-square" },
	ask: { category: "agents", icon: "message-circle-question" },
	todo: { category: "agents", icon: "list-checks" },
};

const MCP: ToolKind = { category: "other", icon: "plug" };
const UNKNOWN: ToolKind = { category: "other", icon: "wrench" };

/** Category and icon for a tool name: known tools by name, `mcp__*` as plug, everything else as wrench. */
export function toolKind(name: string): ToolKind {
	if (Object.hasOwn(KINDS, name)) return KINDS[name]!;
	return name.startsWith("mcp__") ? MCP : UNKNOWN;
}
