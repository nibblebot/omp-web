/** MCP tools are named `mcp__<server>_<tool>` (SDK mcp/tool-bridge.ts:428). */
const MCP_PREFIX = "mcp__";

/** Whether a tool name is an MCP bridge tool (`mcp__<server>_<tool>`). */
export function isMcpTool(name: string): boolean {
	return name.startsWith(MCP_PREFIX);
}

/**
 * Whether a tool result renders as Markdown under `mcp.renderMarkdownResults`.
 * Same rule as the TUI (pi-tui tools/mcp.ts:194): non-empty MCP text that is
 * not a JSON document. Non-JSON text that merely starts with a bracket stays
 * eligible.
 */
export function isMarkdownMcpResult(name: string, output: string): boolean {
	if (!isMcpTool(name)) return false;
	const trimmed = output.trim();
	if (trimmed.length === 0) return false;
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			JSON.parse(trimmed);
			return false;
		} catch {
			// Not JSON: still eligible for Markdown.
		}
	}
	return true;
}
