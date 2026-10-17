import { describe, expect, test } from "bun:test";
import {
	buildMcpInput,
	EMPTY_MCP_FORM,
	formFromServer,
	type McpFormValues,
	parseArgLines,
	parsePairLines,
} from "../../components/settings/integrations/mcp-form";

const stdio: McpFormValues = {
	...EMPTY_MCP_FORM,
	name: " local ",
	command: " node ",
	argsText: "server.js\n\n--port 9000 ",
	envText: "API_KEY=abc\nTOKEN=x",
};

const remote: McpFormValues = {
	...EMPTY_MCP_FORM,
	name: "remote",
	transport: "http",
	url: " https://example.com/mcp ",
	headersText: "Authorization: Bearer t",
};

describe("MCP form helpers", () => {
	test("parsePairLines splits on the separator, keeps bare keys as null", () => {
		expect(parsePairLines("A=1\nB\nC=\n=bad\n  D = two = parts ", "=")).toEqual({
			A: "1",
			B: null,
			C: null,
			D: "two = parts",
		});
	});

	test("parseArgLines trims and drops blank lines", () => {
		expect(parseArgLines(" a \n\n b\n")).toEqual(["a", "b"]);
	});

	test("add builds a trimmed stdio input with parsed env", () => {
		expect(buildMcpInput(stdio, "add")).toEqual({
			ok: true,
			input: {
				name: "local",
				scope: "user",
				transport: "stdio",
				command: "node",
				args: ["server.js", "--port 9000"],
				env: { API_KEY: "abc", TOKEN: "x" },
			},
		});
	});

	test("add rejects a bare env key because nothing is stored yet", () => {
		const result = buildMcpInput({ ...stdio, envText: "API_KEY" }, "add");
		expect(result).toEqual({
			ok: false,
			error: "Give API_KEY a value (KEY=value), or remove the line.",
		});
	});

	test("edit keeps a bare env key as null so the stored value survives", () => {
		const result = buildMcpInput({ ...stdio, envText: "API_KEY" }, "edit");
		expect(result.ok && result.input.transport === "stdio" && result.input.env).toEqual({
			API_KEY: null,
		});
	});

	test("remote add omits the token when blank and rejects a bare header", () => {
		const ok = buildMcpInput(remote, "add");
		expect(ok).toEqual({
			ok: true,
			input: {
				name: "remote",
				scope: "user",
				transport: "http",
				url: "https://example.com/mcp",
				headers: { Authorization: "Bearer t" },
			},
		});
		expect(buildMcpInput({ ...remote, headersText: "Authorization" }, "add")).toEqual({
			ok: false,
			error: "Give Authorization a value (Name: value), or remove the line.",
		});
	});

	test("remote input carries a trimmed token when one is entered", () => {
		const result = buildMcpInput({ ...remote, token: " tok " }, "add");
		expect(result.ok && result.input.transport === "http" && result.input.token).toBe("tok");
	});

	test("required fields report a readable error", () => {
		expect(buildMcpInput({ ...stdio, name: " " }, "add")).toEqual({
			ok: false,
			error: "Name the server.",
		});
		expect(buildMcpInput({ ...stdio, command: "" }, "add")).toEqual({
			ok: false,
			error: "Enter the command to run.",
		});
		expect(buildMcpInput({ ...remote, url: "" }, "add")).toEqual({
			ok: false,
			error: "Enter the server URL.",
		});
	});

	test("formFromServer prefills key names only and maps discovered servers to user scope", () => {
		const form = formFromServer({
			name: "api",
			transport: "stdio",
			status: "connected",
			enabled: true,
			scope: "discovered",
			writable: false,
			command: "uvx",
			args: ["svc"],
			envKeys: ["API_KEY"],
			auth: "none",
		});
		expect(form).toMatchObject({
			name: "api",
			scope: "user",
			command: "uvx",
			argsText: "svc",
			envText: "API_KEY",
			token: "",
		});
	});
});
