import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { McpServerSummary, SkillSummary } from "#lib/wire/protocol";
import * as transport from "../../store/transport";

// The transport is mocked; the store module is imported after the mock so it binds to it.
let handler: (method: string, args: unknown) => Promise<unknown> = async () => undefined;
const originalTransport = { ...transport };
mock.module("../../store/transport", () => ({
	...originalTransport,
	call: (method: string, args: unknown) => handler(method, args),
}));

afterAll(() => {
	// mock.restore() leaves module mocks installed; reinstall the real exports for later files.
	mock.module("../../store/transport", () => originalTransport);
});

const integrations = await import("../../store/integrations");
const { createIntegrationState } = await import("../../store/slices/integrations");
const { setState, state } = await import("../../state");

const skill = (name: string, enabled: boolean): SkillSummary => ({
	name,
	description: `${name} skill`,
	source: "OMP (project)",
	path: `/repo/.omp/skills/${name}/SKILL.md`,
	enabled,
	hidden: false,
});

const server = (name: string, enabled: boolean): McpServerSummary => ({
	name,
	transport: "stdio",
	status: enabled ? "connected" : "disabled",
	enabled,
	scope: "project",
	writable: true,
	command: "npx",
	auth: "none",
});

const mcpState = (servers: McpServerSummary[]) => ({
	servers,
	paths: { user: "/u/mcp.json", project: "/p/mcp.json" },
	projectConfigEnabled: true,
});

beforeEach(() => {
	setState("integrations", createIntegrationState());
	setState("integrations", {
		skills: [skill("pdf", true), skill("changelog", false)],
		mcpServers: [server("filesystem", true), server("postgres", false)],
	});
});

afterEach(() => {
	setState("integrations", createIntegrationState());
});

describe("skill switch", () => {
	test("flips at once and keeps the authoritative reply", async () => {
		let release!: () => void;
		handler = (method) => {
			expect(method).toBe("setSkillEnabled");
			return new Promise((resolve) => {
				release = () =>
					resolve({ skills: [skill("pdf", false), skill("changelog", false)], warnings: [] });
			});
		};
		integrations.setSkillEnabled("pdf", false);
		expect(state.integrations.skills[0].enabled).toBe(false);
		expect(integrations.extensionBusy("skill", "pdf")).toBe(true);
		release();
		await Bun.sleep(0);
		expect(state.integrations.skills.map((s) => s.enabled)).toEqual([false, false]);
		expect(integrations.extensionBusy("skill", "pdf")).toBe(false);
	});

	test("a failed write reverts the switch and shows the error", async () => {
		handler = async () => {
			throw new Error("settings file is read-only");
		};
		integrations.setSkillEnabled("changelog", true);
		expect(state.integrations.skills[1].enabled).toBe(true);
		await Bun.sleep(0);
		expect(state.integrations.skills[1].enabled).toBe(false);
		expect(integrations.skillsError()).toBe("settings file is read-only");
		expect(integrations.extensionBusy("skill", "changelog")).toBe(false);
	});
});

describe("MCP switch", () => {
	test("a refused result reverts the switch and shows the error", async () => {
		handler = async (method) => {
			if (method === "getMcpState")
				return mcpState([server("filesystem", true), server("postgres", false)]);
			return { ok: false, detail: "mcp.json is not writable" };
		};
		integrations.setMcpServerEnabled("postgres", true);
		expect(state.integrations.mcpServers[1].enabled).toBe(true);
		await Bun.sleep(0);
		expect(state.integrations.mcpServers[1].enabled).toBe(false);
		expect(integrations.mcpError()).toBe("mcp.json is not writable");
	});

	test("a thrown error reverts the switch", async () => {
		handler = async (method) => {
			if (method === "getMcpState")
				return mcpState([server("filesystem", true), server("postgres", false)]);
			throw new Error("session unreachable");
		};
		integrations.setMcpServerEnabled("filesystem", false);
		expect(state.integrations.mcpServers[0].enabled).toBe(false);
		await Bun.sleep(0);
		expect(state.integrations.mcpServers[0].enabled).toBe(true);
		expect(integrations.mcpError()).toBe("session unreachable");
	});
});

describe("selection", () => {
	test("opening on a group selects its first item once the list loads", async () => {
		handler = async (method) => {
			if (method === "getMcpState")
				return mcpState([server("filesystem", true), server("postgres", false)]);
			if (method === "mcpInspect") return { tools: [], resources: [], prompts: [] };
			throw new Error(`unexpected ${method}`);
		};
		integrations.openIntegrations("extensions", "mcp");
		expect(state.modal).toBe("integrations");
		expect(state.integrations.extensionsFocus).toBe("mcp");
		expect(state.integrations.extensionsSelected).toBeNull();
		integrations.refreshMcp();
		await Bun.sleep(0);
		expect(state.integrations.extensionsSelected).toEqual({ kind: "mcp", name: "filesystem" });
		expect(state.integrations.extensionsFocus).toBeNull();
		// The narrow layout stays on the list: opening never drills in by itself.
		expect(state.integrations.extensionsDrill).toBe(false);
		setState("modal", null);
	});

	test("picking a skill drills in and loads its detail", async () => {
		const detail = { ...skill("pdf", true), body: "# Steps", alwaysApply: false, globs: ["*.pdf"] };
		handler = async (method, args) => {
			expect(method).toBe("getSkillDetail");
			expect(args).toEqual(["pdf"]);
			return detail;
		};
		integrations.selectExtension({ kind: "skill", name: "pdf" });
		expect(state.integrations.extensionsDrill).toBe(true);
		expect(state.integrations.skillDetail?.loading).toBe(true);
		await Bun.sleep(0);
		expect(state.integrations.skillDetail).toEqual({
			name: "pdf",
			detail,
			loading: false,
			error: null,
		});
	});

	test("the search filters both groups by name, description, and source", () => {
		integrations.setExtensionsQuery("changelog");
		expect(integrations.visibleSkills().map((s) => s.name)).toEqual(["changelog"]);
		expect(integrations.visibleMcpServers()).toEqual([]);
		integrations.setExtensionsQuery("project config");
		expect(integrations.visibleMcpServers()).toHaveLength(2);
	});
});
