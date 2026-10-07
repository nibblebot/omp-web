import type { WebMethodName } from "#lib/wire/protocol";
import { call, setState, state } from "../state";
import { requestDangerConfirm } from "../prompt/danger-confirm";
import { validateOAuthLaunchUrl } from "./integration-oauth";

export interface McpServerEntry {
	name: string;
	transport?: string;
	enabled?: boolean;
	status?: string;
	error?: string | null;
	source?: string;
}
export interface SkillEntry {
	id: string;
	source?: string;
	version?: string;
	enabled?: boolean;
	description?: string;
}
export interface PluginEntry extends SkillEntry {}
export type IntegrationScope = "project" | "profile";
export interface IntegrationState {
	mcpServers: McpServerEntry[];
	mcpLoading: boolean;
	mcpError: string | null;
	mcpUnavailable: string | null;
	mcpTestResult: { server: string; text: string } | null;
	mcpInspection: { server: string; kind: string; text: string } | null;
	mcpInspecting: boolean;
	skills: SkillEntry[];
	plugins: PluginEntry[];
	skillsLoading: boolean;
	skillsError: string | null;
	skillsUnavailable: string | null;
	skillResults: SkillEntry[];
	skillSearching: boolean;
	smitheryAvailable: boolean;
	reloadStatus: string | null;
}
export function createIntegrationState(): IntegrationState {
	return {
		mcpServers: [] as McpServerEntry[],
		mcpLoading: false,
		mcpError: null as string | null,
		mcpUnavailable: null as string | null,
		mcpTestResult: null as { server: string; text: string } | null,
		mcpInspection: null as { server: string; kind: string; text: string } | null,
		mcpInspecting: false,
		skills: [] as SkillEntry[],
		plugins: [] as PluginEntry[],
		skillsLoading: false,
		skillsError: null as string | null,
		skillsUnavailable: null as string | null,
		skillResults: [] as SkillEntry[],
		skillSearching: false,
		smitheryAvailable: false,
		reloadStatus: null as string | null,
	};
}
export const mcpServers = () => state.integrations.mcpServers;
export const mcpLoading = () => state.integrations.mcpLoading;
export const mcpError = () => state.integrations.mcpError;
export const mcpUnavailable = () => state.integrations.mcpUnavailable;
export const mcpTestResult = () => state.integrations.mcpTestResult;
export const mcpInspection = () => state.integrations.mcpInspection;
export const mcpInspecting = () => state.integrations.mcpInspecting;
export const skills = () => state.integrations.skills;
export const plugins = () => state.integrations.plugins;
export const skillsLoading = () => state.integrations.skillsLoading;
export const skillsError = () => state.integrations.skillsError;
export const skillsUnavailable = () => state.integrations.skillsUnavailable;
export const skillResults = () => state.integrations.skillResults;
export const skillSearching = () => state.integrations.skillSearching;
export const smitheryAvailable = () => state.integrations.smitheryAvailable;
export const reloadStatus = () => state.integrations.reloadStatus;

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid integration response");
	return value as Record<string, unknown>;
}
function entries(value: unknown): SkillEntry[] {
	if (!Array.isArray(value)) throw new Error("Invalid integration inventory");
	return value.map((item) => {
		const row = record(item);
		if (typeof row.id !== "string") throw new Error("Integration inventory is missing an ID");
		return {
			id: row.id,
			source: typeof row.source === "string" ? row.source : undefined,
			version: typeof row.version === "string" ? row.version : undefined,
			enabled: typeof row.enabled === "boolean" ? row.enabled : undefined,
			description: typeof row.description === "string" ? row.description : undefined,
		};
	});
}
function servers(value: unknown): McpServerEntry[] {
	if (!Array.isArray(value)) throw new Error("Invalid MCP inventory");
	return value.map((item) => {
		const row = record(item);
		if (typeof row.name !== "string") throw new Error("MCP inventory is missing a server name");
		return {
			name: row.name,
			transport: typeof row.transport === "string" ? row.transport : undefined,
			enabled: typeof row.enabled === "boolean" ? row.enabled : undefined,
			status: typeof row.status === "string" ? row.status : undefined,
			error: typeof row.error === "string" ? row.error : null,
			source: typeof row.source === "string" ? row.source : undefined,
		};
	});
}
function fail(area: "mcp" | "skills", error: unknown) {
	setState(
		"integrations",
		area === "mcp" ? "mcpError" : "skillsError",
		error instanceof Error ? error.message : String(error),
	);
}
async function request(method: WebMethodName, args: unknown[] = []) {
	const session = state.sessionId;
	const result = await call(method, args);
	if (session !== state.sessionId)
		throw new Error("Session changed during integration operation; refresh the current session.");
	return result;
}
export function refreshMcp(): void {
	setState("integrations", "mcpLoading", true);
	setState("integrations", "mcpError", null);
	void request("getMcpState")
		.then((data) => setState("integrations", "mcpServers", servers(record(data).servers)))
		.catch((error) => fail("mcp", error))
		.finally(() => setState("integrations", "mcpLoading", false));
}
function mcpMutate(method: WebMethodName, args: unknown[]) {
	setState("integrations", "mcpError", null);
	void request(method, args)
		.then(() => refreshMcp())
		.catch((error) => fail("mcp", error));
}
export interface McpAddConfig {
	name: string;
	transport: string;
	url?: string;
	command?: string;
	args?: string[];
	scope: IntegrationScope;
}
export function addMcpServer(config: McpAddConfig): void {
	requestDangerConfirm({
		title: "Trust MCP server?",
		body: "This server can expose tools and instructions to the agent. A local command executes with daemon permissions. Only connect sources you trust.",
		confirmLabel: "Connect",
		onConfirm: () => mcpMutate("mcpAdd", [{ ...config, trusted: true }]),
	});
}
export function updateMcpServer(name: string, config: McpAddConfig): void {
	requestDangerConfirm({
		title: "Trust updated MCP server?",
		body: "Changing this server can execute a new local command or connect new tools with daemon permissions.",
		confirmLabel: "Update",
		onConfirm: () => mcpMutate("mcpUpdate", [name, { ...config, trusted: true }]),
	});
}
export const removeMcpServer = (name: string) => mcpMutate("mcpRemove", [name]);
export const reconnectMcpServer = (name: string) => mcpMutate("mcpReconnect", [name]);
export const reloadMcpServer = (name?: string) => mcpMutate("mcpReload", name ? [name] : []);
export const enableMcpServer = (name: string) => mcpMutate("mcpEnable", [name]);
export const disableMcpServer = (name: string) => mcpMutate("mcpDisable", [name]);
export const revokeMcpOAuth = (name: string) => mcpMutate("mcpOAuthRevoke", [name]);
export function testMcpServer(name: string): void {
	setState("integrations", "mcpTestResult", null);
	void request("mcpTest", [name])
		.then((data) => {
			const row = record(data);
			setState("integrations", "mcpTestResult", {
				server: name,
				text: `${row.ok === true ? "Connected" : "Failed"}: ${typeof row.detail === "string" ? row.detail : "No details returned"}`,
			});
			refreshMcp();
		})
		.catch((error) => fail("mcp", error));
}
export function inspectMcp(
	name: string,
	kind: string,
	target?: string,
	args?: Record<string, string>,
): void {
	setState("integrations", "mcpInspecting", true);
	void request("mcpInspect", [name, kind, target, args])
		.then((data) => {
			const row = record(data);
			if (typeof row.text !== "string") throw new Error("Invalid MCP inspection response");
			setState("integrations", "mcpInspection", { server: name, kind, text: row.text });
		})
		.catch((error) => fail("mcp", error))
		.finally(() => setState("integrations", "mcpInspecting", false));
}
export function reauthMcpServer(name: string): void {
	// Reserve the popup in the click handler; opening after an RPC is blocked by browsers.
	const popup = window.open("about:blank", "_blank");
	if (!popup) {
		fail("mcp", new Error("Allow popups to open the OAuth provider, then retry."));
		return;
	}
	popup.opener = null;
	void request("mcpOAuthReauth", [name])
		.then((data) => {
			const row = record(data);
			popup.location.replace(validateOAuthLaunchUrl(row.url));
			refreshMcp();
		})
		.catch((error) => {
			popup.close();
			fail("mcp", error);
		});
}
export function refreshSkills(): void {
	setState("integrations", "skillsLoading", true);
	setState("integrations", "skillsError", null);
	void request("getSkillsState")
		.then((data) => {
			const row = record(data);
			setState("integrations", {
				skills: entries(row.skills),
				plugins: entries(row.plugins),
				smitheryAvailable: row.smitheryAvailable === true,
			});
		})
		.catch((error) => fail("skills", error))
		.finally(() => setState("integrations", "skillsLoading", false));
}
export function searchSkills(query: string): void {
	setState("integrations", "skillSearching", true);
	void request("skillSearch", [query])
		.then((data) => setState("integrations", "skillResults", entries(record(data).results)))
		.catch((error) => fail("skills", error))
		.finally(() => setState("integrations", "skillSearching", false));
}
function skillMutate(method: WebMethodName, args: unknown[]) {
	setState("integrations", "skillsError", null);
	void request(method, args)
		.then(() => {
			refreshSkills();
			refreshMcp();
		})
		.catch((error) => fail("skills", error));
}
function trust(title: string, id: string, run: () => void) {
	requestDangerConfirm({
		title,
		body: `Only install code you trust. Skills can instruct the agent to run commands; plugins execute with daemon permissions. This can read files or disclose data.\n\nSource: ${id}`,
		confirmLabel: "Trust and continue",
		onConfirm: run,
	});
}
export function installSkill(id: string, scope: IntegrationScope = "profile"): void {
	trust("Install skill?", id, () => skillMutate("skillInstall", [id, { trusted: true, scope }]));
}
export function updateSkill(id: string, scope: IntegrationScope = "profile"): void {
	trust("Trust updated skill?", id, () =>
		skillMutate("skillUpdate", [id, { trusted: true, scope }]),
	);
}
export const uninstallSkill = (id: string) => skillMutate("skillUninstall", [id]);
export function managePlugin(
	action: "install" | "update" | "uninstall" | "enable" | "disable",
	id: string,
	scope: IntegrationScope = "profile",
): void {
	const run = () => skillMutate("pluginManage", [action, id, { trusted: true, scope }]);
	if (action === "install" || action === "update" || action === "enable")
		trust("Trust plugin code?", id, run);
	else run();
}
export function reloadIntegrations(): void {
	requestDangerConfirm({
		title: "Reload integrations?",
		body: "Reload tools, instructions, skills, and extensions from disk. If runtime replacement is necessary, it may stop active work and dispose extension UI. Your session identity, transcript, and unsent browser draft must be preserved. The server will refuse unsafe active operations rather than silently restart.",
		confirmLabel: "Reload",
		onConfirm: () => {
			void request("reloadIntegrations", [{ consent: true }])
				.then((data) => {
					const row = record(data);
					if (row.restartRequired === true)
						throw new Error(
							typeof row.detail === "string"
								? row.detail
								: "Runtime reload unavailable; explicitly restart the session runtime before continuing.",
						);
					setState(
						"integrations",
						"reloadStatus",
						typeof row.detail === "string" ? row.detail : "Runtime integrations reloaded.",
					);
					refreshSkills();
					refreshMcp();
				})
				.catch((error) => fail("skills", error));
		},
	});
}
