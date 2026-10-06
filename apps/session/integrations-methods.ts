import type { SessionEntry } from "./session-entry";

// G11 integration rows backed by the SDK's real reload surface. The planned
// mcp-service/skills-service modules never landed; the ONLY verified
// SDK reload operations are session.refreshSkillsAndCommands() (skills +
// file-based slash commands + prompt rebuild + command-metadata notify) and
// session.refreshSkills(). MCP add/remove/test/reconnect/reload/enable/
// OAuth/inspect rows refuse with explicit unavailable until a headless
// extraction of the TUI wizards lands; they never fake success.

export type IntegrationArgs = Record<string, unknown>;

function object(value: unknown): IntegrationArgs {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Integration options must be an object");
	return { ...(value as IntegrationArgs) };
}
function text(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim())
		throw new Error(`${field} must be a nonempty string`);
	return value;
}
function consent(options: IntegrationArgs): IntegrationArgs {
	if (options.trusted !== undefined && typeof options.trusted !== "boolean")
		throw new Error("trusted must be a boolean");
	if (options.consent !== undefined && typeof options.consent !== "boolean")
		throw new Error("consent must be a boolean");
	if (options.confirmed !== undefined && typeof options.confirmed !== "boolean")
		throw new Error("confirmed must be a boolean");
	if (options.trusted === true || options.consent === true) options.confirmed = true;
	delete options.trusted;
	delete options.consent;
	return options;
}
function skillScope(options: IntegrationArgs): IntegrationArgs {
	if (options.scope !== undefined) {
		if (options.scope !== "project" && options.scope !== "profile")
			throw new Error("scope must be project or profile");
		options.global = options.scope === "profile";
		delete options.scope;
	}
	return options;
}

/** The browser's positional command arguments are translated, never silently coerced. */
export function normalizeIntegrationArgs(method: string, args: unknown[]): IntegrationArgs {
	if (!Array.isArray(args)) throw new Error("Integration arguments must be an array");
	const max =
		method === "mcpInspect"
			? 4
			: method === "pluginManage"
				? 3
				: method === "mcpUpdate" || method === "skillInstall" || method === "skillUpdate"
					? 2
					: 1;
	if (args.length > max) throw new Error("Too many integration arguments");
	if (method === "getMcpState" || method === "getSkillsState")
		return args.length ? object(args[0]) : {};
	if (method === "reloadIntegrations" || method === "mcpAdd" || method === "mcpSmithery")
		return consent(object(args[0]));
	if (method === "skillSearch") return { query: text(args[0], "query") };
	if (method === "skillInstall" || method === "skillUpdate") {
		const id = text(args[0], "id");
		return {
			...skillScope(consent(args[1] === undefined ? {} : object(args[1]))),
			[method === "skillInstall" ? "specs" : "names"]: [id],
		};
	}
	if (method === "skillUninstall") return { names: [text(args[0], "id")] };
	if (method === "pluginManage") {
		const action = text(args[0], "action");
		const id = text(args[1], "id");
		const options = consent(args[2] === undefined ? {} : object(args[2]));
		if (options.scope === "profile") options.scope = "user";
		return { ...options, action, ...(action === "install" ? { source: id } : { name: id }) };
	}
	const name = text(args[0], "name");
	if (method === "mcpUpdate") return { ...consent(object(args[1])), name };
	if (method === "mcpInspect") {
		const target = text(args[1], "kind");
		if (!["resources", "prompts", "notifications", "resource", "prompt"].includes(target))
			throw new Error("Unsupported MCP inspection kind");
		const selected = args[2] === undefined ? undefined : text(args[2], "target");
		return {
			name,
			target:
				selected && target === "resources"
					? "resource"
					: selected && target === "prompts"
						? "prompt"
						: target,
			...(selected ? { uri: selected, prompt: selected } : {}),
			...(args[3] === undefined ? {} : { arguments: object(args[3]) }),
		};
	}
	return { name };
}

export interface IntegrationMethodsDeps {
	broadcastState: (entry: SessionEntry) => void | Promise<void>;
	broadcastAvailableCommands: (entry: SessionEntry) => void | Promise<void>;
}

type Handler = (entry: SessionEntry, args: IntegrationArgs) => Promise<unknown>;

function unavailable(method: string): Handler {
	return async () => {
		throw new Error(
			`${method} is unavailable: no headless MCP/skill extraction has landed; the TUI wizards remain the supported path.`,
		);
	};
}

export function createIntegrationMethods(deps: IntegrationMethodsDeps) {
	const reloadIntegrations: Handler = async (entry, args) => {
		if (args.consent !== true && args.confirmed !== true)
			throw new Error("reloadIntegrations requires explicit consent (confirm the reload dialog).");
		await entry.session.refreshSkillsAndCommands();
		await deps.broadcastAvailableCommands(entry);
		await deps.broadcastState(entry);
		return {
			reloaded: true,
			detail: "Skills and commands rediscovered; MCP server management still requires the TUI.",
		};
	};
	const services: Record<string, Handler> = {
		getMcpState: unavailable("getMcpState"),
		mcpAdd: unavailable("mcpAdd"),
		mcpUpdate: unavailable("mcpUpdate"),
		mcpRemove: unavailable("mcpRemove"),
		mcpTest: unavailable("mcpTest"),
		mcpReconnect: unavailable("mcpReconnect"),
		mcpReload: unavailable("mcpReload"),
		mcpEnable: unavailable("mcpEnable"),
		mcpDisable: unavailable("mcpDisable"),
		mcpOAuthReauth: unavailable("mcpOAuthReauth"),
		mcpOAuthRevoke: unavailable("mcpOAuthRevoke"),
		mcpInspect: unavailable("mcpInspect"),
		getSkillsState: async () => ({
			skills: [],
			plugins: [],
			smitheryAvailable: false,
			note: "skill inventory extraction has not landed",
		}),
		skillSearch: unavailable("skillSearch"),
		skillInstall: unavailable("skillInstall"),
		skillUpdate: unavailable("skillUpdate"),
		skillUninstall: unavailable("skillUninstall"),
		pluginManage: unavailable("pluginManage"),
		reloadIntegrations,
	};
	const readOnly: Record<string, true> = {
		getMcpState: true,
		getSkillsState: true,
		skillSearch: true,
		mcpInspect: true,
	};
	const methods: Record<
		string,
		(entry: SessionEntry, args: unknown[], streamId?: number) => Promise<unknown>
	> = {};
	for (const [name, handler] of Object.entries(services)) {
		const run: (entry: SessionEntry, args: unknown[]) => Promise<unknown> = (entry, args) =>
			handler(entry, normalizeIntegrationArgs(name, args));
		methods[name] = async (entry, args) => {
			const result = await run(entry, args);
			if (!readOnly[name] && name !== "reloadIntegrations") {
				await deps.broadcastAvailableCommands(entry);
				await deps.broadcastState(entry);
			}
			return result;
		};
	}
	return {
		methods,
		readOnly,
		getIntegrationsState: async () => ({
			mcp: { servers: [], note: "MCP management extraction has not landed" },
			skills: { skills: [], plugins: [], smitheryAvailable: false },
		}),
		reloadIntegrations: (entry: SessionEntry, args: IntegrationArgs = {}) =>
			reloadIntegrations(entry, args),
	};
}
