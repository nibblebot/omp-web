import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "#lib/testkit/temp-dir.testkit";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createMcpMethods } from "../mcp-methods";
import type { SessionEntry } from "../session-entry";

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
