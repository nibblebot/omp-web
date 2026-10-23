import type {
	McpActionResult,
	McpConnectionState,
	McpInspection,
	McpScope,
	McpServerInput,
	McpServerSummary,
	McpState,
	McpTestResult,
	SkillDetail,
	SkillSummary,
	SkillsState,
	WebMethodName,
} from "#lib/wire/protocol";
import { call, setState, state } from "../state";
import { requestDangerConfirm } from "../prompt/danger-confirm";
import { pushToast } from "./toasts";
import {
	integrationsOpenPatch,
	skillsPatch,
	type ExtensionKind,
	type ExtensionRef,
	type IntegrationTab,
} from "./slices/integrations";

export const mcpServers = () => state.integrations.mcpServers;
export const mcpPaths = () => state.integrations.mcpPaths;
export const mcpProjectConfigEnabled = () => state.integrations.mcpProjectConfigEnabled;
export const mcpLoading = () => state.integrations.mcpLoading;
export const mcpError = () => state.integrations.mcpError;
export const mcpTestResult = () => state.integrations.mcpTestResult;
export const mcpInspection = () => state.integrations.mcpInspection;
export const mcpInspecting = () => state.integrations.mcpInspecting;
export const mcpInspectError = () => state.integrations.mcpInspectError;
export const skills = () => state.integrations.skills;
export const skillWarnings = () => state.integrations.skillWarnings;
export const skillsRevision = () => state.integrations.skillsRevision;
export const skillsLoading = () => state.integrations.skillsLoading;
export const skillsError = () => state.integrations.skillsError;
export const skillDetail = () => state.integrations.skillDetail;
export const integrationsTab = () => state.integrations.tab;
export const extensionsQuery = () => state.integrations.extensionsQuery;
export const extensionsSelected = () => state.integrations.extensionsSelected;
export const extensionsDrill = () => state.integrations.extensionsDrill;

/** Switches the dialog's active tab without opening it. */
export function selectIntegrationsTab(tab: IntegrationTab): void {
	setState("integrations", "tab", tab);
}

/**
 * Opens the Extensions dialog on `tab` (used by `/mcp`, `/skills`, and the command palette).
 * `group` selects that group's first item once its list loads.
 */
export function openIntegrations(tab: IntegrationTab, group: ExtensionKind | null = null): void {
	setState("integrations", integrationsOpenPatch(tab, group));
	setState("modal", "integrations");
}

const MCP_STATUS_LABEL: Record<McpConnectionState, string> = {
	connected: "connected",
	connecting: "connecting",
	disconnected: "not connected",
	disabled: "disabled",
};

export const mcpStatusLabel = (status: McpConnectionState): string => MCP_STATUS_LABEL[status];

/** An MCP server's source: its config scope, or the tool that declared a discovered server. */
export function mcpSourceLabel(server: McpServerSummary): string {
	return server.scope === "discovered" ? (server.source ?? "discovered") : `${server.scope} config`;
}

function matchesQuery(query: string, ...fields: Array<string | undefined>): boolean {
	const needle = query.trim().toLowerCase();
	return needle === "" || fields.join(" ").toLowerCase().includes(needle);
}

/** Skills matching the search text (name, description, source). */
export const visibleSkills = (): SkillSummary[] =>
	skills().filter((skill) =>
		matchesQuery(extensionsQuery(), skill.name, skill.description, skill.source),
	);

/** MCP servers matching the search text (name, source, transport). */
export const visibleMcpServers = (): McpServerSummary[] =>
	mcpServers().filter((server) =>
		matchesQuery(extensionsQuery(), server.name, mcpSourceLabel(server), server.transport),
	);

export const selectedSkill = (): SkillSummary | undefined => {
	const selected = extensionsSelected();
	return selected?.kind === "skill" ? skills().find((s) => s.name === selected.name) : undefined;
};

export const selectedMcpServer = (): McpServerSummary | undefined => {
	const selected = extensionsSelected();
	return selected?.kind === "mcp" ? mcpServers().find((s) => s.name === selected.name) : undefined;
};

export function setExtensionsQuery(query: string): void {
	setState("integrations", "extensionsQuery", query);
}

/** True where a hover pointer and a keyboard are likely (no soft keyboard to pop up on focus). */
export function searchAutofocus(): boolean {
	return (
		typeof matchMedia === "function" && matchMedia("(hover: hover) and (pointer: fine)").matches
	);
}

/** Selects a row and loads its detail. `drill` also shows the detail in the narrow layout. */
export function selectExtension(ref: ExtensionRef, options: { drill?: boolean } = {}): void {
	setState("integrations", {
		extensionsSelected: ref,
		extensionsFocus: null,
		extensionsDrill: options.drill ?? true,
	});
	if (ref.kind === "skill") loadSkillDetail(ref.name);
	else if (mcpServers().find((s) => s.name === ref.name)?.enabled) inspectMcp(ref.name);
}

/** Narrow layout: show the detail (or the add/edit form that takes its place). */
export function showExtensionDetail(): void {
	setState("integrations", "extensionsDrill", true);
}

/** Narrow layout: back from the detail to the list. */
export function leaveExtensionDetail(): void {
	setState("integrations", "extensionsDrill", false);
}

/** Selects the first item of the group an opener asked for, once that group has loaded. */
function resolveExtensionFocus(): void {
	const focus = state.integrations.extensionsFocus;
	if (focus === null || state.integrations.extensionsSelected !== null) return;
	const first = focus === "skill" ? skills()[0] : mcpServers()[0];
	if (first) selectExtension({ kind: focus, name: first.name }, { drill: false });
}

const busyKey = (kind: ExtensionKind, name: string) => `${kind}:${name}`;
export const extensionBusy = (kind: ExtensionKind, name: string): boolean =>
	state.integrations.extensionsBusy.includes(busyKey(kind, name));

function setBusy(kind: ExtensionKind, name: string, busy: boolean): void {
	const key = busyKey(kind, name);
	setState("integrations", "extensionsBusy", (list) =>
		busy ? [...list, key] : list.filter((k) => k !== key),
	);
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
			resolveExtensionFocus();
		})
		.catch((error) => fail("mcp", error))
		.finally(() => setState("integrations", "mcpLoading", false));
}

/** Re-reads the inspection of `name` when it is the selected, enabled server (its tools may have changed). */
function reinspectSelected(name: string): void {
	const selected = state.integrations.extensionsSelected;
	if (selected?.kind === "mcp" && selected.name === name) inspectMcp(name);
}

/** Runs one MCP mutation. The result toast reports success; a failed action surfaces as the panel error. */
function mcpMutate(method: WebMethodName, args: unknown[], after?: () => void): void {
	setState("integrations", "mcpError", null);
	void request(method, args)
		.then((data) => {
			const row = data as McpActionResult;
			if (row.ok) pushToast(row.detail);
			else fail("mcp", new Error(row.detail));
		})
		.catch((error) => fail("mcp", error))
		.finally(() => {
			refreshMcp();
			after?.();
		});
}

/**
 * Switches an MCP server at once and writes it; a failed write (a thrown error or a refused
 * result) puts the switch back and shows the error. The list refetches afterwards for status.
 */
export function setMcpServerEnabled(name: string, enabled: boolean): void {
	const index = state.integrations.mcpServers.findIndex((server) => server.name === name);
	if (index < 0 || extensionBusy("mcp", name)) return;
	const previous = state.integrations.mcpServers[index].enabled;
	const revert = () =>
		setState("integrations", "mcpServers", (server) => server.name === name, "enabled", previous);
	setState("integrations", "mcpError", null);
	setState("integrations", "mcpServers", index, "enabled", enabled);
	setBusy("mcp", name, true);
	let applied = false;
	void request(enabled ? "mcpEnable" : "mcpDisable", [name])
		.then((data) => {
			const row = data as McpActionResult;
			if (row.ok) {
				applied = true;
				pushToast(row.detail);
			} else {
				revert();
				fail("mcp", new Error(row.detail));
			}
		})
		.catch((error) => {
			revert();
			fail("mcp", error);
		})
		.finally(() => {
			setBusy("mcp", name, false);
			refreshMcp();
			if (applied && enabled) reinspectSelected(name);
		});
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

export const reconnectMcpServer = (name: string) =>
	mcpMutate("mcpReconnect", [name], () => reinspectSelected(name));
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
	setState("integrations", { mcpInspecting: name, mcpInspectError: null });
	void request("mcpInspect", [name])
		.then((data) =>
			setState("integrations", "mcpInspection", {
				server: name,
				inspection: data as McpInspection,
			}),
		)
		.catch((error) =>
			setState("integrations", "mcpInspectError", {
				server: name,
				message: error instanceof Error ? error.message : String(error),
			}),
		)
		.finally(() => {
			if (state.integrations.mcpInspecting === name)
				setState("integrations", "mcpInspecting", null);
		});
}

function applySkills(data: unknown): void {
	setState("integrations", skillsPatch(state.integrations, data as SkillsState));
}

export function refreshSkills(): void {
	setState("integrations", "skillsLoading", true);
	setState("integrations", "skillsError", null);
	void request("getSkillsState")
		.then((data) => {
			applySkills(data);
			resolveExtensionFocus();
		})
		.catch((error) => fail("skills", error))
		.finally(() => setState("integrations", "skillsLoading", false));
}

/** Loads `name`'s full detail. A reload of the shown skill keeps its current detail on screen. */
export function loadSkillDetail(name: string): void {
	const previous = state.integrations.skillDetail;
	setState("integrations", "skillDetail", {
		name,
		detail: previous?.name === name ? previous.detail : null,
		loading: true,
		error: null,
	});
	const current = () => state.integrations.skillDetail?.name === name;
	void request("getSkillDetail", [name])
		.then((data) => {
			if (current())
				setState("integrations", "skillDetail", {
					name,
					detail: data as SkillDetail,
					loading: false,
					error: null,
				});
		})
		.catch((error) => {
			if (current())
				setState("integrations", "skillDetail", (detail) => ({
					name,
					detail: detail?.detail ?? null,
					loading: false,
					error: error instanceof Error ? error.message : String(error),
				}));
		});
}

/**
 * Switches a skill at once and writes it; a failed write puts the switch back and shows the
 * error. The write's reply (and the `skills_changed` broadcast) carries the authoritative state.
 */
export function setSkillEnabled(name: string, enabled: boolean): void {
	const index = state.integrations.skills.findIndex((skill) => skill.name === name);
	if (index < 0 || extensionBusy("skill", name)) return;
	const previous = state.integrations.skills[index].enabled;
	setState("integrations", "skillsError", null);
	setState("integrations", "skills", index, "enabled", enabled);
	setBusy("skill", name, true);
	void request("setSkillEnabled", [name, enabled])
		.then(applySkills)
		.catch((error) => {
			setState("integrations", "skills", (skill) => skill.name === name, "enabled", previous);
			fail("skills", error);
		})
		.finally(() => setBusy("skill", name, false));
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
