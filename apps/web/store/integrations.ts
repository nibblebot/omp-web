import type {
	McpActionResult,
	McpInspection,
	McpScope,
	McpServerInput,
	McpState,
	McpTestResult,
	SkillsState,
	WebMethodName,
} from "#lib/wire/protocol";
import { call, setPromptInsert, setState, state } from "../state";
import { requestDangerConfirm } from "../prompt/danger-confirm";
import { pushToast } from "./toasts";
import type { IntegrationTab } from "./slices/integrations";

export const mcpServers = () => state.integrations.mcpServers;
export const mcpPaths = () => state.integrations.mcpPaths;
export const mcpProjectConfigEnabled = () => state.integrations.mcpProjectConfigEnabled;
export const mcpLoading = () => state.integrations.mcpLoading;
export const mcpError = () => state.integrations.mcpError;
export const mcpTestResult = () => state.integrations.mcpTestResult;
export const mcpInspection = () => state.integrations.mcpInspection;
export const mcpInspecting = () => state.integrations.mcpInspecting;
export const skills = () => state.integrations.skills;
export const skillWarnings = () => state.integrations.skillWarnings;
export const skillsLoading = () => state.integrations.skillsLoading;
export const skillsError = () => state.integrations.skillsError;
export const integrationsTab = () => state.integrations.tab;

/** Switches the sheet's active tab without opening it. */
export function selectIntegrationsTab(tab: IntegrationTab): void {
	setState("integrations", "tab", tab);
}

/** Opens the Integrations sheet on `tab` (used by `/mcp`, `/skills`, and the feature commands). */
export function openIntegrations(tab: IntegrationTab): void {
	setState("integrations", "tab", tab);
	setState("modal", "integrations");
}

function fail(area: "mcp" | "skills", error: unknown) {
	setState(
		"integrations",
		area === "mcp" ? "mcpError" : "skillsError",
		error instanceof Error ? error.message : String(error),
	);
}

async function request(method: WebMethodName, args: unknown[] = []): Promise<unknown> {
	const session = state.sessionId;
	const result = await call(method, args);
	if (session !== state.sessionId)
		throw new Error("Session changed during integration operation; refresh the current session.");
	return result;
}

export function refreshMcp(): void {
	setState("integrations", "mcpLoading", true);
	void request("getMcpState")
		.then((data) => {
			const row = data as McpState;
			setState("integrations", {
				mcpServers: row.servers,
				mcpPaths: row.paths,
				mcpProjectConfigEnabled: row.projectConfigEnabled,
			});
		})
		.catch((error) => fail("mcp", error))
		.finally(() => setState("integrations", "mcpLoading", false));
}

/** Runs one MCP mutation. The result toast reports success; a failed action surfaces as the panel error. */
function mcpMutate(method: WebMethodName, args: unknown[]): void {
	setState("integrations", "mcpError", null);
	void request(method, args)
		.then((data) => {
			const row = data as McpActionResult;
			if (row.ok) pushToast(row.detail);
			else fail("mcp", new Error(row.detail));
		})
		.catch((error) => fail("mcp", error))
		.finally(() => refreshMcp());
}

/** Trust copy names what will run (command, args, URL) and env or header keys, never their values. */
function launchSummary(input: McpServerInput): string {
	const keys = (map?: Record<string, unknown>) => Object.keys(map ?? {}).join(", ") || "none";
	if (input.transport === "stdio") {
		return [
			`Runs: ${[input.command ?? "", ...(input.args ?? [])].join(" ").trim()}`,
			`Environment variables (names only): ${keys(input.env)}`,
		].join("\n");
	}
	return [
		`Connects to: ${input.url ?? ""}`,
		`Header names (values hidden): ${keys(input.headers)}${input.token ? ", Authorization (bearer token)" : ""}`,
	].join("\n");
}

function trustBody(input: McpServerInput, action: string): string {
	return [
		`${action} "${input.name}" (${input.scope} config).`,
		launchSummary(input),
		"",
		"An MCP server can expose tools and instructions to the agent. A local command runs with session process permissions. Only add servers you trust.",
	].join("\n");
}

export function addMcpServer(input: McpServerInput): void {
	requestDangerConfirm({
		title: "Trust MCP server?",
		body: trustBody(input, "Add"),
		confirmLabel: "Add server",
		onConfirm: () => mcpMutate("mcpAdd", [input]),
	});
}

export function updateMcpServer(input: McpServerInput): void {
	requestDangerConfirm({
		title: "Trust changed MCP server?",
		body: trustBody(input, "Save changes to"),
		confirmLabel: "Save changes",
		onConfirm: () => mcpMutate("mcpUpdate", [input]),
	});
}

export function removeMcpServer(name: string, scope: McpScope): void {
	requestDangerConfirm({
		title: "Remove MCP server?",
		body: `${name} is removed from the ${scope} config file. Its tools leave the agent on the next reload.`,
		confirmLabel: "Remove",
		onConfirm: () => mcpMutate("mcpRemove", [name, scope]),
	});
}

export const reconnectMcpServer = (name: string) => mcpMutate("mcpReconnect", [name]);
export const enableMcpServer = (name: string) => mcpMutate("mcpEnable", [name]);
export const disableMcpServer = (name: string) => mcpMutate("mcpDisable", [name]);
export const revokeMcpOAuth = (name: string) => mcpMutate("mcpOAuthRevoke", [name]);

export function testMcpServer(name: string): void {
	setState("integrations", "mcpTestResult", null);
	void request("mcpTest", [name])
		.then((data) =>
			setState("integrations", "mcpTestResult", { server: name, result: data as McpTestResult }),
		)
		.catch((error) => fail("mcp", error));
}

export function inspectMcp(name: string): void {
	setState("integrations", "mcpInspecting", true);
	void request("mcpInspect", [name])
		.then((data) =>
			setState("integrations", "mcpInspection", {
				server: name,
				inspection: data as McpInspection,
			}),
		)
		.catch((error) => fail("mcp", error))
		.finally(() => setState("integrations", "mcpInspecting", false));
}

function applySkills(data: unknown): void {
	const row = data as SkillsState;
	setState("integrations", { skills: row.skills, skillWarnings: row.warnings });
}

export function refreshSkills(): void {
	setState("integrations", "skillsLoading", true);
	setState("integrations", "skillsError", null);
	void request("getSkillsState")
		.then(applySkills)
		.catch((error) => fail("skills", error))
		.finally(() => setState("integrations", "skillsLoading", false));
}

export function setSkillEnabled(name: string, enabled: boolean): void {
	setState("integrations", "skillsError", null);
	void request("setSkillEnabled", [name, enabled])
		.then(applySkills)
		.catch((error) => fail("skills", error));
}

/**
 * Invoke a skill the way the TUI's `/skill:<name>` does: close the sheet, prefill the composer
 * with the command and a trailing space (arguments are optional and typed there), and focus it.
 * Enter then runs it through the normal slash-command path.
 */
export function invokeSkill(name: string): void {
	setState("modal", null);
	setPromptInsert({ text: `/skill:${name} ` });
}

/** Trust copy for code-bearing installs; the plugin toggle in the Plugins tab calls it too. */
export function trust(title: string, id: string, run: () => void) {
	requestDangerConfirm({
		title,
		body: `Only install code you trust. Skills can instruct the agent to run commands; plugins execute with session process permissions. This can read files or disclose data.\n\nSource: ${id}`,
		confirmLabel: "Trust and continue",
		onConfirm: run,
	});
}

/** One click, no consent: skills and commands rediscover, MCP servers reconnect. */
export function reloadIntegrations(): void {
	setState("integrations", "mcpError", null);
	void request("reloadIntegrations")
		.then((data) => {
			const row = data as McpActionResult;
			if (row.ok) pushToast(row.detail);
			else fail("mcp", new Error(row.detail));
		})
		.catch((error) => fail("mcp", error))
		.finally(() => {
			refreshSkills();
			refreshMcp();
		});
}
