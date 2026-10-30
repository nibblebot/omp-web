import type {
	McpInspection,
	McpServerInput,
	McpServerSummary,
	PluginDetail,
	PluginSettingValue,
	PluginSummary,
	SkillsState,
} from "#lib/wire/protocol";
import type { CallHandlers } from "../session";
import {
	mcpInspectionFewTools,
	mcpInspectionLinear,
	mcpInspectionTools,
	mcpServers,
	skillDetails,
	skillEntries,
	UNTRUSTED_SKILL_LINE,
} from "./overlays";
import { pluginDetail, pluginSummaries } from "./plugins";

/** getMcpState answer: the four fixture servers and both config paths. */
export const mcpStateFixture = {
	servers: mcpServers,
	paths: {
		user: "/home/joshua/.config/omp/mcp.json",
		project: "/home/joshua/Repos/omp-web/.omp/mcp.json",
	},
	projectConfigEnabled: true,
};

/** getSkillsState answer: the two fixture skills with one warning. */
export const skillsStateFixture: SkillsState = {
	skills: skillEntries,
	warnings: [
		"Skipped /home/joshua/Repos/omp-web/.omp/skills/broken/SKILL.md: missing description.",
	],
};

/** The inspection `mcpInspect` answers per server name; any other server reports nothing. */
const inspections: Record<string, McpInspection> = {
	filesystem: mcpInspectionTools.inspection,
	github: mcpInspectionFewTools.inspection,
	linear: mcpInspectionLinear.inspection,
	postgres: {
		server: { name: "mcp-server-postgres", version: "0.6.2" },
		tools: [
			{
				name: "query",
				description: "Run a read-only SQL query.",
				parameters: [{ name: "sql", type: "string", required: true }],
			},
			{ name: "list_tables", description: "List the tables of the database.", parameters: [] },
			{
				name: "describe_table",
				description: "Columns, types and indexes of a table.",
				parameters: [{ name: "table", type: "string", required: true }],
			},
		],
		resources: [],
		prompts: [],
	},
};

/**
 * `answerCalls` handlers for the Extensions dialog: both inventories, skill detail by name, and
 * MCP inspection by server. Pass overrides to make one of them slow or fail.
 */
export function extensionCalls(overrides: CallHandlers = {}): CallHandlers {
	return {
		getMcpState: () => mcpStateFixture,
		getSkillsState: () => skillsStateFixture,
		getSkillDetail: (args) => {
			const detail = skillDetails[String(args[0])];
			if (!detail) throw new Error(`Unknown skill: ${String(args[0])}`);
			return detail;
		},
		mcpInspect: (args) => inspections[String(args[0])] ?? { tools: [], resources: [], prompts: [] },
		...overrides,
	};
}

/** The fixture servers with every enabled one connected: the oauth server signed in, no errors. */
function connectedServers(): McpServerSummary[] {
	return mcpServers.map(({ error: _error, ...server }) =>
		server.enabled
			? { ...server, status: "connected", toolCount: inspections[server.name]?.tools.length }
			: server,
	);
}

/**
 * Every Extensions dialog call over one in-memory inventory, as a healthy session answers it:
 * every enabled MCP server connected, no skill warnings, and writes that stick (toggling a
 * server, skill or plugin, adding, editing and removing a server, plugin features and settings).
 */
export function extensionStateCalls(): CallHandlers {
	let servers = connectedServers();
	let skills = structuredClone(skillEntries);
	let plugins: PluginSummary[] = structuredClone(pluginSummaries);
	const details = new Map<string, PluginDetail>([
		[pluginDetail.name, structuredClone(pluginDetail)],
		...plugins
			.filter((plugin) => plugin.name !== pluginDetail.name)
			.map((plugin): [string, PluginDetail] => [
				plugin.name,
				{ ...plugin, features: [], featuresCustomized: false, settings: [] },
			]),
	]);
	const done = (detail: string) => ({ ok: true, detail });
	const setServer = (name: string, patch: Partial<McpServerSummary>) => {
		servers = servers.map((server) => (server.name === name ? { ...server, ...patch } : server));
	};
	const fromInput = (input: McpServerInput): McpServerSummary => ({
		name: input.name,
		transport: input.transport,
		status: "connected",
		enabled: true,
		scope: input.scope,
		writable: true,
		...(input.transport === "stdio"
			? { command: input.command, args: input.args ?? [], envKeys: Object.keys(input.env ?? {}) }
			: { url: input.url, headerNames: Object.keys(input.headers ?? {}) }),
		auth: input.token ? "token" : "none",
		toolCount: 4,
		toggleFile:
			input.scope === "project" ? mcpStateFixture.paths.project : mcpStateFixture.paths.user,
	});
	const plugin = (name: unknown): PluginDetail => {
		const detail = details.get(String(name));
		if (detail === undefined) throw new Error(`Unknown plugin: ${String(name)}`);
		return detail;
	};
	const savePlugin = (detail: PluginDetail): PluginDetail => {
		details.set(detail.name, detail);
		plugins = plugins.map((row) =>
			row.name === detail.name ? { ...row, enabled: detail.enabled } : row,
		);
		return structuredClone(detail);
	};
	return {
		...extensionCalls(),
		getMcpState: () => ({ ...mcpStateFixture, servers: structuredClone(servers) }),
		getSkillsState: () => ({ skills: structuredClone(skills), warnings: [] }),
		getSkillDetail: (args) => {
			const detail = skillDetails[String(args[0])];
			if (!detail) throw new Error(`Unknown skill: ${String(args[0])}`);
			// The sanitizer check belongs to the stories: a real SKILL.md has no such line.
			return { ...detail, body: detail.body.replace(`\n\n${UNTRUSTED_SKILL_LINE}`, "") };
		},
		mcpEnable: (args) => {
			setServer(String(args[0]), {
				enabled: true,
				status: "connected",
				toolCount: inspections[String(args[0])]?.tools.length,
			});
			return done(`Enabled ${String(args[0])}.`);
		},
		mcpDisable: (args) => {
			setServer(String(args[0]), { enabled: false, status: "disabled" });
			return done(`Disabled ${String(args[0])}.`);
		},
		mcpReconnect: (args) => done(`Reconnected ${String(args[0])}.`),
		mcpOAuthRevoke: (args) => done(`Signed out of ${String(args[0])}.`),
		mcpTest: (args) => ({
			ok: true,
			detail: "Connected in 84 ms.",
			tools: (inspections[String(args[0])]?.tools ?? []).map((tool) => tool.name),
		}),
		mcpAdd: (args) => {
			const input = args[0] as McpServerInput;
			servers = [...servers, fromInput(input)];
			return done(`Added ${input.name}.`);
		},
		mcpUpdate: (args) => {
			const input = args[0] as McpServerInput;
			servers = servers.map((server) => (server.name === input.name ? fromInput(input) : server));
			return done(`Saved ${input.name}.`);
		},
		mcpRemove: (args) => {
			servers = servers.filter((server) => server.name !== String(args[0]));
			return done(`Removed ${String(args[0])}.`);
		},
		setSkillEnabled: (args) => {
			skills = skills.map((skill) =>
				skill.name === String(args[0]) ? { ...skill, enabled: args[1] === true } : skill,
			);
			return { skills: structuredClone(skills), warnings: [] } satisfies SkillsState;
		},
		reloadIntegrations: () => done("Reloaded skills, commands and MCP servers."),
		listPlugins: () => structuredClone(plugins),
		getPluginConfig: (args) => structuredClone(plugin(args[0])),
		setPluginEnabled: (args) => savePlugin({ ...plugin(args[0]), enabled: args[1] === true }),
		setPluginFeatures: (args) => {
			const detail = plugin(args[0]);
			const picked = args[1] as string[] | null;
			return savePlugin({
				...detail,
				featuresCustomized: picked !== null,
				features: detail.features.map((feature) => ({
					...feature,
					enabled: picked === null ? feature.default : picked.includes(feature.name),
				})),
			});
		},
		setPluginSetting: (args) => {
			const detail = plugin(args[0]);
			const value = args[2] as PluginSettingValue | null;
			return savePlugin({
				...detail,
				settings: detail.settings.map((setting) =>
					setting.key !== String(args[1])
						? setting
						: value === null
							? { ...setting, value: undefined, set: false }
							: { ...setting, value, set: true },
				),
			});
		},
	};
}
