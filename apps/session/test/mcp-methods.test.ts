import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { readDisabledServers } from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import { getAgentDir, getMCPConfigPath, setAgentDir } from "@oh-my-pi/pi-utils";
import { createMcpMethods } from "../mcp-methods";
import type { SessionEntry } from "../session-entry";

afterAll(cleanupTempDirs);

const SECRET_ENV = "sk-live-env-value-123";
const SECRET_HEADER = "Bearer hdr-token-456";
const SECRET_URL_USER = "uzer";
const SECRET_URL_PASS = "pass-789";
const SECRET_QUERY = "q-token-000";

function makeProject(mcpServers: Record<string, unknown>): string {
	const cwd = tempDir("mcp-state-cwd-");
	mkdirSync(join(cwd, ".omp"), { recursive: true });
	writeFileSync(join(cwd, ".omp", "mcp.json"), JSON.stringify({ mcpServers }));
	return cwd;
}

function makeEntry(cwd: string, enableProjectConfig: boolean): SessionEntry {
	const settings = Settings.isolated({ "mcp.enableProjectConfig": enableProjectConfig });
	return {
		cwd,
		mcpManager: undefined,
		session: {
			settings,
			getEvalPreludes: () => [],
			effectiveExtensionRoots: undefined,
			refreshMCPTools: async () => {},
		},
	} as unknown as SessionEntry;
}

const deps = { broadcastAvailableCommands: async () => {} };

describe("session mcp methods: getMcpState", () => {
	test("lists project servers with key names only and never secret values", async () => {
		const cwd = makeProject({
			local: {
				command: "node",
				args: ["server.js", "--port", "9000"],
				env: { API_KEY: SECRET_ENV },
			},
			remote: {
				type: "http",
				url: `https://${SECRET_URL_USER}:${SECRET_URL_PASS}@example.com/mcp?token=${SECRET_QUERY}`,
				headers: { Authorization: SECRET_HEADER },
			},
		});
		const methods = createMcpMethods(deps);
		const state = (await methods.getMcpState(makeEntry(cwd, true), [])) as {
			servers: Array<Record<string, unknown>>;
			paths: { user: string; project: string };
			projectConfigEnabled: boolean;
		};

		const local = state.servers.find((server) => server.name === "local");
		const remote = state.servers.find((server) => server.name === "remote");
		expect(local).toMatchObject({
			transport: "stdio",
			scope: "project",
			writable: true,
			envKeys: ["API_KEY"],
		});
		expect(remote).toMatchObject({
			transport: "http",
			scope: "project",
			writable: true,
			headerNames: ["Authorization"],
		});
		expect(remote?.url).toBe("https://example.com/mcp");
		expect(state.projectConfigEnabled).toBe(true);
		expect(state.paths.project.endsWith(join(".omp", "mcp.json"))).toBe(true);

		const serialized = JSON.stringify(state);
		for (const secret of [
			SECRET_ENV,
			SECRET_HEADER,
			SECRET_URL_USER,
			SECRET_URL_PASS,
			SECRET_QUERY,
		]) {
			expect(serialized).not.toContain(secret);
		}
	});

	test("reports the project-config toggle from settings", async () => {
		const cwd = makeProject({});
		const methods = createMcpMethods(deps);
		const state = (await methods.getMcpState(makeEntry(cwd, false), [])) as {
			projectConfigEnabled: boolean;
		};
		expect(state.projectConfigEnabled).toBe(false);
	});
});

function makeLiveEntry(cwd: string, initiallyLive: string[]) {
	const live = new Set(initiallyLive);
	const calls = { disconnectAll: 0, disconnected: [] as string[], discovered: 0 };
	const manager = {
		getAllServerNames: () => [...live],
		getTools: () => [],
		disconnectAll: async () => {
			calls.disconnectAll++;
			live.clear();
		},
		disconnectServer: async (name: string) => {
			calls.disconnected.push(name);
			live.delete(name);
		},
		discoverAndConnect: async () => {
			calls.discovered++;
			return { errors: new Map<string, string>() };
		},
	};
	const base = makeEntry(cwd, true);
	const entry = {
		...base,
		mcpManager: manager,
		session: { ...base.session, setMCPPromptCommands: () => {}, mcpPromptCommands: [] },
	} as unknown as SessionEntry;
	return { entry, calls, live };
}

describe("session mcp methods: per-server reloads", () => {
	test("adding a server disconnects no live server and never reconnects all", async () => {
		const cwd = makeProject({});
		const { entry, calls, live } = makeLiveEntry(cwd, ["alpha"]);
		await createMcpMethods(deps).mcpAdd(entry, [
			{ name: "beta", scope: "project", transport: "stdio", command: "node", args: [] },
		]);
		expect(calls.disconnectAll).toBe(0);
		expect(calls.disconnected).not.toContain("alpha");
		expect([...live]).toEqual(["alpha"]);
		expect(calls.discovered).toBe(1);
	});

	test("removing a server disconnects only that server", async () => {
		const cwd = makeProject({ beta: { command: "node", args: [] } });
		const { entry, calls, live } = makeLiveEntry(cwd, ["alpha", "beta"]);
		await createMcpMethods(deps).mcpRemove(entry, ["beta", "project"]);
		expect(calls.disconnectAll).toBe(0);
		expect(calls.disconnected).toEqual(["beta"]);
		expect([...live]).toEqual(["alpha"]);
	});
});

describe("session mcp methods: toggle file routing", () => {
	// The user mcp.json lives under the agent dir; point it at a temp dir so the
	// denylist fallback never touches the real one.
	const previousEnv = process.env.PI_CODING_AGENT_DIR;
	const previousDir = getAgentDir();
	beforeAll(() => setAgentDir(tempDir("mcp-agent-dir-")));
	afterAll(() => {
		setAgentDir(previousDir);
		if (previousEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousEnv;
	});

	type Source = { provider: string; providerName: string; path: string; level: string };

	/** A live entry whose manager knows `discovered` servers declared outside the project/user files. */
	function entryWithManager(cwd: string, discovered: Record<string, Source>) {
		const sources = new Map(Object.entries(discovered));
		const stdio = { command: "node", args: [] as string[] };
		const manager = {
			getAllServerNames: () => [...sources.keys()],
			getServerConfig: () => stdio,
			getSource: (name: string) => sources.get(name),
			getConnectionStatus: () => "disconnected",
			getTools: () => [],
			disconnectServer: async () => {},
			discoverAndConnect: async () => ({ errors: new Map<string, string>() }),
		};
		const base = makeEntry(cwd, true);
		return {
			...base,
			mcpManager: manager,
			session: { ...base.session, setMCPPromptCommands: () => {}, mcpPromptCommands: [] },
		} as unknown as SessionEntry;
	}

	type StateShape = { servers: Array<{ name: string; toggleFile?: string }> };

	test("a server declared in another owned file toggles in that file, not the user config", async () => {
		const cwd = makeProject({});
		const otherFile = join(cwd, "pkg", ".mcp.json");
		mkdirSync(join(cwd, "pkg"), { recursive: true });
		writeFileSync(
			otherFile,
			JSON.stringify({ mcpServers: { ext: { command: "node", args: [] } } }),
		);
		const entry = entryWithManager(cwd, {
			ext: { provider: "mcp-json", providerName: "MCP JSON", path: otherFile, level: "project" },
		});
		const methods = createMcpMethods(deps);

		const state = (await methods.getMcpState(entry, [])) as StateShape;
		expect(state.servers.find((server) => server.name === "ext")?.toggleFile).toBe(otherFile);

		await methods.mcpDisable(entry, ["ext"]);
		expect(JSON.parse(readFileSync(otherFile, "utf8")).mcpServers.ext.enabled).toBe(false);
		await expect(readDisabledServers(getMCPConfigPath("user", cwd))).resolves.toEqual([]);

		await methods.mcpEnable(entry, ["ext"]);
		expect(JSON.parse(readFileSync(otherFile, "utf8")).mcpServers.ext.enabled).toBe(true);
	});

	test("a project server reports and writes the project file", async () => {
		const cwd = makeProject({ local: { command: "node", args: [] } });
		const projectFile = getMCPConfigPath("project", cwd);
		const entry = entryWithManager(cwd, {});
		const methods = createMcpMethods(deps);

		const state = (await methods.getMcpState(entry, [])) as StateShape;
		expect(state.servers.find((server) => server.name === "local")?.toggleFile).toBe(projectFile);
		await methods.mcpDisable(entry, ["local"]);
		expect(JSON.parse(readFileSync(projectFile, "utf8")).mcpServers.local.enabled).toBe(false);
	});

	test("a tool-owned source is never written: the toggle lands in the user denylist", async () => {
		const cwd = makeProject({});
		const toolFile = join(cwd, "opencode.json");
		writeFileSync(toolFile, JSON.stringify({ mcp: { foreign: { command: "node" } } }));
		const entry = entryWithManager(cwd, {
			foreign: { provider: "opencode", providerName: "OpenCode", path: toolFile, level: "project" },
		});
		const userFile = getMCPConfigPath("user", cwd);
		const methods = createMcpMethods(deps);

		const state = (await methods.getMcpState(entry, [])) as StateShape;
		expect(state.servers.find((server) => server.name === "foreign")?.toggleFile).toBe(userFile);

		await methods.mcpDisable(entry, ["foreign"]);
		await expect(readDisabledServers(userFile)).resolves.toEqual(["foreign"]);
		expect(readFileSync(toolFile, "utf8")).toBe(
			JSON.stringify({ mcp: { foreign: { command: "node" } } }),
		);
	});
});

describe("session mcp methods: mcpInspect", () => {
	// A minimal stdio MCP server: newline-delimited JSON-RPC, one tool with a typed input schema.
	const SERVER = `
const tools = [{
	name: "search",
	title: "Search docs",
	description: "Find pages.",
	inputSchema: {
		type: "object",
		properties: {
			query: { type: "string", description: "Search text" },
			limit: { type: "number" },
			mode: { enum: ["fast", "deep"] },
		},
		required: ["query"],
	},
}];
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
for await (const chunk of process.stdin) {
	for (const line of chunk.toString().split("\\n")) {
		if (!line.trim()) continue;
		const msg = JSON.parse(line);
		if (msg.method === "initialize") {
			reply(msg.id, {
				protocolVersion: msg.params.protocolVersion,
				capabilities: { tools: {} },
				serverInfo: { name: "fixture-server", version: "1.2.3" },
			});
		} else if (msg.method === "tools/list") reply(msg.id, { tools });
		else if (msg.id !== undefined) reply(msg.id, {});
	}
}
`;

	test("reports the server implementation and tool titles with typed parameters", async () => {
		const dir = tempDir("mcp-inspect-");
		const script = join(dir, "server.js");
		writeFileSync(script, SERVER);
		const cwd = makeProject({ fixture: { command: process.execPath, args: [script] } });
		const base = makeEntry(cwd, true);
		const entry = {
			...base,
			session: { ...base.session, modelRegistry: { authStorage: undefined } },
		} as unknown as SessionEntry;

		const inspection = (await createMcpMethods(deps).mcpInspect(entry, ["fixture"])) as {
			server?: { name: string; version?: string };
			tools: Array<{
				name: string;
				title?: string;
				parameters?: Array<{
					name: string;
					type?: string;
					required: boolean;
					description?: string;
				}>;
			}>;
		};
		expect(inspection.server).toEqual({ name: "fixture-server", version: "1.2.3" });
		expect(inspection.tools).toHaveLength(1);
		expect(inspection.tools[0]).toMatchObject({ name: "search", title: "Search docs" });
		expect(inspection.tools[0]?.parameters).toEqual([
			{ name: "query", type: "string", required: true, description: "Search text" },
			{ name: "limit", type: "number", required: false, description: undefined },
			{ name: "mode", type: "enum", required: false, description: undefined },
		]);
	}, 20_000);
});

describe("session mcp methods: mcp.enableProjectConfig off", () => {
	// A project command that records its launch: the opt-out must keep it from ever starting.
	function optedOutEntry() {
		const dir = tempDir("mcp-optout-");
		const marker = join(dir, "spawned");
		const script = join(dir, "server.js");
		writeFileSync(script, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x");`);
		const cwd = makeProject({ repoOnly: { command: process.execPath, args: [script] } });
		return { entry: makeEntry(cwd, false), marker };
	}

	test("test and inspect refuse a project-only server without spawning its command", async () => {
		const { entry, marker } = optedOutEntry();
		const methods = createMcpMethods(deps);
		const message = /declared in the project config, which is off \(mcp\.enableProjectConfig\)/;
		await expect(methods.mcpTest(entry, ["repoOnly"])).rejects.toThrow(message);
		await expect(methods.mcpInspect(entry, ["repoOnly"])).rejects.toThrow(message);
		expect(existsSync(marker)).toBe(false);
	});

	test("a server unknown to every config still reports unknown", async () => {
		const { entry } = optedOutEntry();
		await expect(createMcpMethods(deps).mcpTest(entry, ["nope"])).rejects.toThrow(
			"Unknown MCP server: nope",
		);
	});
});
