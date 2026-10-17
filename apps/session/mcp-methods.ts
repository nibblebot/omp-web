import { validateServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import {
	connectToServer,
	disconnectServer,
	listPrompts,
	listResources,
	listTools,
} from "@oh-my-pi/pi-coding-agent/mcp/client";
import {
	addMCPServer,
	readDisabledServers,
	readMCPConfigFile,
	removeMCPServer,
	setMcpServerEnabled,
	updateMCPServer,
	validateServerName,
} from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import {
	mcpOAuthCredentialIdsForServerUrl,
	removeManagedMcpOAuthCredentials,
} from "@oh-my-pi/pi-coding-agent/mcp/oauth-credentials";
import { cfgMcpEnableProjectConfig } from "@oh-my-pi/pi-coding-agent/mcp/settings";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { getMCPConfigPath } from "@oh-my-pi/pi-utils";
import type {
	McpActionResult,
	McpConnectionState,
	McpInspection,
	McpScope,
	McpServerInput,
	McpServerSummary,
	McpState,
	McpTestResult,
	McpTransport,
	WebMethodName,
} from "#lib/wire/protocol";
import type { SessionEntry } from "./session-entry";

// MCP integration methods. Config writes go through the SDK config-writer and
// every change reloads the SDK manager, the same flow the TUI `/mcp` uses.
// Secret values (env, header values, tokens) are never returned: summaries
// carry key names only.

export interface McpMethodsDeps {
	broadcastAvailableCommands(entry: SessionEntry): Promise<void>;
}

type Handler = (entry: SessionEntry, args: unknown[]) => Promise<unknown>;
type Connection = Awaited<ReturnType<typeof connectToServer>>;
type McpMethodName = Extract<WebMethodName, "getMcpState" | "reloadIntegrations" | `mcp${string}`>;

/** Last discovery failure per manager, so a server that never connected can say why. */
const discoveryErrors = new WeakMap<MCPManager, Map<string, string>>();

// Serializes config writes and reloads; a reload disconnects every server, so
// two overlapping reloads would race on the manager.
let tail: Promise<unknown> = Promise.resolve();
function serialized<T>(run: () => Promise<T>): Promise<T> {
	const next = tail.then(run, run);
	tail = next.then(
		() => undefined,
		() => undefined,
	);
	return next;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function text(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
	return value.trim();
}

function scopeOf(value: unknown): McpScope {
	if (value !== "user" && value !== "project") throw new Error("scope must be user or project");
	return value;
}

function parseInput(value: unknown): McpServerInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("MCP server input must be an object");
	}
	const input = value as McpServerInput;
	if (input.transport !== "stdio" && input.transport !== "http" && input.transport !== "sse") {
		throw new Error("transport must be stdio, http or sse");
	}
	return { ...input, name: text(input.name, "name"), scope: scopeOf(input.scope) };
}

function paths(cwd: string): Record<McpScope, string> {
	return { user: getMCPConfigPath("user", cwd), project: getMCPConfigPath("project", cwd) };
}

async function readServers(filePath: string): Promise<Record<string, MCPServerConfig>> {
	return (await readMCPConfigFile(filePath)).mcpServers ?? {};
}

function requireManager(entry: SessionEntry): MCPManager {
	if (!entry.mcpManager) throw new Error("MCP is not enabled for this session");
	return entry.mcpManager;
}

async function hasServer(entry: SessionEntry, name: string): Promise<boolean> {
	if (entry.mcpManager?.getAllServerNames().includes(name)) return true;
	const p = paths(entry.cwd);
	return (
		Object.hasOwn(await readServers(p.project), name) ||
		Object.hasOwn(await readServers(p.user), name)
	);
}

async function findConfig(entry: SessionEntry, name: string): Promise<MCPServerConfig> {
	const live = entry.mcpManager?.getServerConfig(name);
	if (live) return live;
	const p = paths(entry.cwd);
	const declared = (await readServers(p.project))[name] ?? (await readServers(p.user))[name];
	if (!declared) throw new Error(`Unknown MCP server: ${name}`);
	return declared;
}

/** Merges env/header edits: a `null` value keeps the stored value; an omitted key is removed. */
function mergeValues(
	prev: Record<string, string> | undefined,
	next: Record<string, string | null> | undefined,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(next ?? {})) {
		if (value !== null) out[key] = value;
		else if (prev && Object.hasOwn(prev, key)) out[key] = prev[key] as string;
	}
	return out;
}

function buildConfig(input: McpServerInput, prev?: MCPServerConfig): MCPServerConfig {
	const transport = input.transport;
	// Carry unrelated options (timeout, oauth, enabled, ...) only across a same-transport edit.
	const base =
		prev && (prev.type ?? "stdio") === (transport === "stdio" ? "stdio" : transport)
			? prev
			: undefined;
	if (transport === "stdio") {
		return {
			...base,
			type: "stdio",
			command: text(input.command, "command"),
			args: input.args ?? [],
			env: mergeValues(base && "env" in base ? base.env : undefined, input.env),
		} as MCPServerConfig;
	}
	const raw = text(input.url, "url");
	const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
	const headers = mergeValues(base && "headers" in base ? base.headers : undefined, input.headers);
	if (input.token) headers.Authorization = `Bearer ${input.token}`;
	return { ...base, type: transport, url, headers } as MCPServerConfig;
}

function assertValid(name: string, config: MCPServerConfig): void {
	const errors = validateServerConfig(name, config);
	if (errors.length > 0) throw new Error(errors.join("; "));
}

/** Drops userinfo, query and fragment; a URL may embed credentials or tokens. */
function sanitizeUrl(url: string): string {
	return url.replace(/\/\/[^@/]*@/, "//").split(/[?#]/)[0] ?? "";
}

interface ReadContext {
	manager?: MCPManager;
	disabled: Set<string>;
	errors: Map<string, string>;
	toolCounts: Map<string, number>;
}

function summarize(
	name: string,
	config: MCPServerConfig,
	scope: McpServerSummary["scope"],
	writable: boolean,
	ctx: ReadContext,
	source?: string,
): McpServerSummary {
	const enabled = config.enabled !== false && !ctx.disabled.has(name);
	const status: McpConnectionState = enabled
		? (ctx.manager?.getConnectionStatus(name) ?? "disconnected")
		: "disabled";
	let transport: McpTransport = "stdio";
	if ("url" in config) transport = config.type === "sse" ? "sse" : "http";
	const headerNames = "url" in config && config.headers ? Object.keys(config.headers) : undefined;
	const hasAuthHeader = headerNames?.some((key) => key.toLowerCase() === "authorization") ?? false;
	let auth: McpServerSummary["auth"] = "none";
	if (config.auth?.type === "oauth") auth = "oauth";
	else if (config.auth || hasAuthHeader) auth = "token";
	return {
		name,
		transport,
		status,
		enabled,
		scope,
		writable,
		source,
		command: "command" in config ? config.command : undefined,
		args: "args" in config ? config.args : undefined,
		envKeys: "command" in config && config.env ? Object.keys(config.env) : undefined,
		url: "url" in config ? sanitizeUrl(config.url) : undefined,
		headerNames,
		auth,
		toolCount: ctx.toolCounts.get(name) ?? 0,
		error: ctx.errors.get(name),
	};
}

async function readState(entry: SessionEntry): Promise<McpState> {
	const manager = entry.mcpManager;
	const p = paths(entry.cwd);
	const [project, user, disabledList] = await Promise.all([
		readServers(p.project),
		readServers(p.user),
		readDisabledServers(p.user),
	]);
	const toolCounts = new Map<string, number>();
	for (const tool of manager?.getTools() ?? []) {
		const server = (tool as { mcpServerName?: string }).mcpServerName;
		if (server) toolCounts.set(server, (toolCounts.get(server) ?? 0) + 1);
	}
	const ctx: ReadContext = {
		manager,
		disabled: new Set(disabledList),
		errors: (manager && discoveryErrors.get(manager)) ?? new Map(),
		toolCounts,
	};
	const servers: McpServerSummary[] = [];
	const seen = new Set<string>();
	for (const [name, config] of Object.entries(project)) {
		seen.add(name);
		servers.push(summarize(name, config, "project", true, ctx));
	}
	for (const [name, config] of Object.entries(user)) {
		if (seen.has(name)) continue;
		seen.add(name);
		servers.push(summarize(name, config, "user", true, ctx));
	}
	for (const name of manager?.getAllServerNames() ?? []) {
		if (seen.has(name)) continue;
		const config = manager?.getServerConfig(name);
		if (!config) continue;
		const source = manager?.getSource(name);
		servers.push(
			summarize(
				name,
				config,
				"discovered",
				false,
				ctx,
				source ? `${source.providerName} (${source.path})` : undefined,
			),
		);
	}
	return {
		servers,
		paths: { user: p.user, project: p.project },
		projectConfigEnabled: cfgMcpEnableProjectConfig.get(entry.session.settings),
	};
}

/** Rediscovers and reconnects every server, then rebinds MCP tools. Mirrors the TUI reload. */
async function reloadServers(entry: SessionEntry): Promise<McpActionResult> {
	const manager = requireManager(entry);
	await manager.disconnectAll();
	// Clear prompt commands before rediscovery so removed servers leave no stale `/server:prompt` entries.
	entry.session.setMCPPromptCommands([]);
	// External edits to mcp.json otherwise keep a stale command or env after reload.
	clearFsCache();
	const result = await manager.discoverAndConnect({
		enableProjectConfig: cfgMcpEnableProjectConfig.get(entry.session.settings),
		filterExa: true,
		filterBrowser: entry.session
			.getEvalPreludes()
			.some((definition) => definition.name === "browser"),
		extensionRoots: entry.session.effectiveExtensionRoots,
	});
	discoveryErrors.set(manager, result.errors);
	await entry.session.refreshMCPTools(manager.getTools());
	const failed = result.errors.size;
	return {
		ok: failed === 0,
		detail:
			failed === 0 ? "MCP servers reloaded" : `MCP servers reloaded, ${failed} failed to connect`,
	};
}

async function withConnection<T>(
	entry: SessionEntry,
	name: string,
	config: MCPServerConfig,
	run: (connection: Connection) => Promise<T>,
): Promise<T> {
	// A short-lived manager resolves auth the same way the live one does, without touching the session's connections.
	const probe = new MCPManager(entry.cwd);
	probe.setAuthStorage(entry.session.modelRegistry.authStorage);
	const prepared = await probe.prepareConfig(config);
	const connection = await connectToServer(name, prepared);
	try {
		return await run(connection);
	} finally {
		await disconnectServer(connection);
	}
}

export function createMcpMethods(deps: McpMethodsDeps): Record<McpMethodName, Handler> {
	// Every mutation also refreshes slash commands, since MCP prompts and tools feed them.
	const mutating =
		(op: Handler): Handler =>
		(entry, args) =>
			serialized(async () => {
				const result = await op(entry, args);
				await deps.broadcastAvailableCommands(entry);
				return result;
			});

	const add = mutating(async (entry, args) => {
		const input = parseInput(args[0]);
		const nameError = validateServerName(input.name);
		if (nameError) throw new Error(nameError);
		if (await hasServer(entry, input.name))
			throw new Error(`An MCP server named "${input.name}" already exists`);
		const config = buildConfig(input);
		assertValid(input.name, config);
		await addMCPServer(paths(entry.cwd)[input.scope], input.name, config);
		return reloadServers(entry);
	});

	const update = mutating(async (entry, args) => {
		const input = parseInput(args[0]);
		const file = paths(entry.cwd)[input.scope];
		const prev = (await readServers(file))[input.name];
		if (!prev) throw new Error(`${input.name} is not declared in the ${input.scope} config`);
		const config = buildConfig(input, prev);
		assertValid(input.name, config);
		await updateMCPServer(file, input.name, config);
		return reloadServers(entry);
	});

	const remove = mutating(async (entry, args) => {
		const name = text(args[0], "name");
		const scope = scopeOf(args[1]);
		const file = paths(entry.cwd)[scope];
		if (!Object.hasOwn(await readServers(file), name)) {
			throw new Error(`${name} is not declared in the ${scope} config`);
		}
		await removeMCPServer(file, name);
		return reloadServers(entry);
	});

	const setEnabled = (enabled: boolean) =>
		mutating(async (entry, args) => {
			const name = text(args[0], "name");
			if (!(await hasServer(entry, name))) throw new Error(`Unknown MCP server: ${name}`);
			const p = paths(entry.cwd);
			await setMcpServerEnabled({ userPath: p.user, projectPath: p.project, name, enabled });
			return reloadServers(entry);
		});

	const reconnect = mutating(async (entry, args): Promise<McpActionResult> => {
		const name = text(args[0], "name");
		const manager = requireManager(entry);
		try {
			const connection = await manager.reconnectServer(name, { manual: true });
			if (!connection) {
				discoveryErrors.get(manager)?.set(name, "Server did not connect");
				return { ok: false, detail: `${name} did not connect` };
			}
			discoveryErrors.get(manager)?.delete(name);
			await entry.session.refreshMCPTools(manager.getTools());
			return { ok: true, detail: `${name} reconnected` };
		} catch (error) {
			const detail = messageOf(error);
			discoveryErrors.get(manager)?.set(name, detail);
			return { ok: false, detail };
		}
	});

	const revoke = mutating(async (entry, args): Promise<McpActionResult> => {
		const name = text(args[0], "name");
		const config = await findConfig(entry, name);
		const url = "url" in config ? config.url : undefined;
		const removed = await removeManagedMcpOAuthCredentials(
			entry.session.modelRegistry.authStorage,
			[...mcpOAuthCredentialIdsForServerUrl(url), config.auth?.credentialId],
		);
		if (removed) await reloadServers(entry);
		return {
			ok: true,
			detail: removed
				? `Revoked stored OAuth credentials for ${name}`
				: `No stored OAuth credentials for ${name}`,
		};
	});

	const test = async (entry: SessionEntry, args: unknown[]): Promise<McpTestResult> => {
		const name = text(args[0], "name");
		const config = await findConfig(entry, name);
		try {
			const tools = await withConnection(entry, name, config, async (connection) =>
				(await listTools(connection)).map((tool) => tool.name),
			);
			return { ok: true, detail: `Connected, ${tools.length} tools`, tools };
		} catch (error) {
			return { ok: false, detail: messageOf(error), tools: [] };
		}
	};

	const inspect = async (entry: SessionEntry, args: unknown[]): Promise<McpInspection> => {
		const name = text(args[0], "name");
		const config = await findConfig(entry, name);
		return withConnection(entry, name, config, async (connection) => {
			const [tools, resources, prompts] = await Promise.all([
				listTools(connection).catch(() => []),
				listResources(connection).catch(() => []),
				listPrompts(connection).catch(() => []),
			]);
			return {
				tools: tools.map((tool) => ({ name: tool.name, description: tool.description })),
				resources: resources.map((resource) => ({
					uri: resource.uri,
					name: resource.name,
					description: resource.description,
				})),
				prompts: prompts.map((prompt) => ({ name: prompt.name, description: prompt.description })),
			};
		});
	};

	return {
		getMcpState: async (entry) => readState(entry),
		mcpAdd: add,
		mcpUpdate: update,
		mcpRemove: remove,
		mcpTest: test,
		mcpInspect: inspect,
		mcpReconnect: reconnect,
		mcpEnable: setEnabled(true),
		mcpDisable: setEnabled(false),
		mcpOAuthRevoke: revoke,
		reloadIntegrations: mutating(async (entry) => {
			const result = await reloadServers(entry);
			await entry.session.refreshSkillsAndCommands();
			return result;
		}),
	};
}
