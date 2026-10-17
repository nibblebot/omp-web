import type { McpScope, McpServerInput, McpServerSummary, McpTransport } from "#lib/wire/protocol";

/** Text-level form state. Multi-value fields are one entry per line. */
export interface McpFormValues {
	name: string;
	transport: McpTransport;
	scope: McpScope;
	command: string;
	argsText: string;
	envText: string;
	url: string;
	headersText: string;
	token: string;
}

export const EMPTY_MCP_FORM: McpFormValues = {
	name: "",
	transport: "stdio",
	scope: "user",
	command: "",
	argsText: "",
	envText: "",
	url: "",
	headersText: "",
	token: "",
};

/**
 * Edit prefill: the summary carries key names only, so every env and header
 * key is a bare line (null on save, which keeps the stored value).
 */
export function formFromServer(server: McpServerSummary): McpFormValues {
	return {
		name: server.name,
		transport: server.transport,
		scope: server.scope === "discovered" ? "user" : server.scope,
		command: server.command ?? "",
		argsText: (server.args ?? []).join("\n"),
		envText: (server.envKeys ?? []).join("\n"),
		url: server.url ?? "",
		headersText: (server.headerNames ?? []).join("\n"),
		token: "",
	};
}

/**
 * Parses `key<sep>value` lines. A bare key yields `null` (keep the stored
 * value on edit). An empty value after the separator also yields `null`.
 */
export function parsePairLines(text: string, sep: "=" | ":"): Record<string, string | null> {
	const out: Record<string, string | null> = {};
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		const at = line.indexOf(sep);
		if (at < 0) {
			out[line] = null;
			continue;
		}
		const key = line.slice(0, at).trim();
		const value = line.slice(at + 1).trim();
		if (key !== "") out[key] = value === "" ? null : value;
	}
	return out;
}

export function parseArgLines(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
}

export type McpFormResult = { ok: true; input: McpServerInput } | { ok: false; error: string };

/** Builds the wire payload. `mode: "add"` rejects bare keys because nothing is stored yet. */
export function buildMcpInput(values: McpFormValues, mode: "add" | "edit"): McpFormResult {
	const name = values.name.trim();
	if (name === "") return { ok: false, error: "Name the server." };
	if (values.transport === "stdio") {
		const command = values.command.trim();
		if (command === "") return { ok: false, error: "Enter the command to run." };
		const env = parsePairLines(values.envText, "=");
		const missing = Object.keys(env).find((key) => env[key] === null);
		if (mode === "add" && missing !== undefined)
			return { ok: false, error: `Give ${missing} a value (KEY=value), or remove the line.` };
		return {
			ok: true,
			input: {
				name,
				scope: values.scope,
				transport: "stdio",
				command,
				args: parseArgLines(values.argsText),
				env,
			},
		};
	}
	const url = values.url.trim();
	if (url === "") return { ok: false, error: "Enter the server URL." };
	const headers = parsePairLines(values.headersText, ":");
	const missing = Object.keys(headers).find((key) => headers[key] === null);
	if (mode === "add" && missing !== undefined)
		return { ok: false, error: `Give ${missing} a value (Name: value), or remove the line.` };
	const token = values.token.trim();
	return {
		ok: true,
		input: {
			name,
			scope: values.scope,
			transport: values.transport,
			url,
			headers,
			...(token === "" ? {} : { token }),
		},
	};
}
