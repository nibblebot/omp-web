/**
 * Installed-plugin config logic shared by the session and fleet backends.
 *
 * Runtime-SDK-free: the SDK PluginManager is reached only through the
 * structural `PluginStore`, and SDK types are imported as types (erased), so
 * static fleet loading stays SDK-free. Secret settings never leave this module
 * with a value or default; writes are accepted but never echoed.
 */

import { lstat } from "node:fs/promises";
import type {
	InstalledPlugin,
	PluginSettingSchema,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import type {
	PluginDetail,
	PluginFeatureRow,
	PluginSettingRow,
	PluginSettingValue,
	PluginSummary,
} from "#lib/wire/protocol";

/** The PluginManager surface the Plugins tab uses. */
export interface PluginStore {
	list(): Promise<InstalledPlugin[]>;
	getPlugin(name: string): Promise<InstalledPlugin | undefined>;
	setEnabled(name: string, enabled: boolean): Promise<void>;
	setEnabledFeatures(name: string, features: string[] | null): Promise<void>;
	getPluginSettings(name: string): Promise<Record<string, unknown>>;
	setPluginSetting(name: string, key: string, value: unknown): Promise<void>;
	deletePluginSetting(name: string, key: string): Promise<void>;
}

/** Client-visible failure; `status` maps to the HTTP status on the fleet edge. */
export class PluginConfigError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 404,
	) {
		super(message);
	}
}

function nonEmptyString(value: string | undefined): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function requirePlugin(store: PluginStore, name: string): Promise<InstalledPlugin> {
	const plugin = await store.getPlugin(name);
	if (!plugin) throw new PluginConfigError(`Unknown plugin: ${name}`, 404);
	return plugin;
}

async function summarize(plugin: InstalledPlugin): Promise<PluginSummary> {
	// `link` installs are symlinks into node_modules; npm installs are real directories.
	const linked = await lstat(plugin.path).then(
		(stat) => stat.isSymbolicLink(),
		() => false,
	);
	const version = nonEmptyString(plugin.version);
	const description = nonEmptyString(plugin.manifest.description);
	return {
		name: plugin.name,
		...(version ? { version } : {}),
		source: linked ? "link" : "npm",
		enabled: plugin.enabled,
		...(description ? { description } : {}),
	};
}

export async function listPlugins(store: PluginStore): Promise<PluginSummary[]> {
	const plugins = await store.list();
	const summaries = await Promise.all(plugins.map(summarize));
	return summaries.sort((a, b) => a.name.localeCompare(b.name));
}

function settingValue(value: unknown): PluginSettingValue | undefined {
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
		? value
		: undefined;
}

function settingRow(
	key: string,
	schema: PluginSettingSchema,
	values: Record<string, unknown>,
): PluginSettingRow {
	const set = values[key] !== undefined;
	const description = nonEmptyString(schema.description);
	const env = nonEmptyString(schema.env);
	const base = {
		key,
		type: schema.type,
		...(description ? { description } : {}),
		secret: schema.secret === true,
		...(env ? { env } : {}),
		set,
	};
	// Secrets: never a value or default on the wire, only `set`.
	if (schema.secret === true) return base;
	const current = settingValue(values[key]);
	const fallback = settingValue(schema.default);
	return {
		...base,
		...(schema.type === "enum" ? { values: [...schema.values] } : {}),
		...(schema.type === "number"
			? {
					...(schema.min !== undefined ? { min: schema.min } : {}),
					...(schema.max !== undefined ? { max: schema.max } : {}),
					...(schema.step !== undefined ? { step: schema.step } : {}),
				}
			: {}),
		...(fallback !== undefined ? { default: fallback } : {}),
		...(current !== undefined ? { value: current } : {}),
	};
}

export async function getPluginConfig(store: PluginStore, name: string): Promise<PluginDetail> {
	const plugin = await requirePlugin(store, name);
	return detailOf(store, plugin);
}

async function detailOf(store: PluginStore, plugin: InstalledPlugin): Promise<PluginDetail> {
	const summary = await summarize(plugin);
	const featureDefs = plugin.manifest.features ?? {};
	const enabledFeatures = plugin.enabledFeatures;
	const features: PluginFeatureRow[] = Object.entries(featureDefs).map(([name, feature]) => {
		const description = nonEmptyString(feature.description);
		const isDefault = feature.default === true;
		return {
			name,
			...(description ? { description } : {}),
			// null means "use defaults", otherwise the explicit list wins.
			enabled: enabledFeatures === null ? isDefault : enabledFeatures.includes(name),
			default: isDefault,
		};
	});
	const values = await store.getPluginSettings(plugin.name);
	const settings = Object.entries(plugin.manifest.settings ?? {}).map(([key, schema]) =>
		settingRow(key, schema, values),
	);
	return {
		...summary,
		features,
		featuresCustomized: enabledFeatures !== null,
		settings,
	};
}

export async function setPluginEnabled(
	store: PluginStore,
	name: string,
	enabled: boolean,
): Promise<PluginDetail> {
	await requirePlugin(store, name);
	await store.setEnabled(name, enabled);
	return getPluginConfig(store, name);
}

/** Wire check for a feature selection: names to enable, or null to clear back to defaults. */
export function parseFeatureSelection(value: unknown): string[] | null {
	if (value === null) return null;
	if (!Array.isArray(value) || !value.every((f) => typeof f === "string")) {
		throw new PluginConfigError("features must be an array of strings or null", 400);
	}
	return value;
}

/** `features: null` clears the explicit selection back to manifest defaults. */
export async function setPluginFeatures(
	store: PluginStore,
	name: string,
	features: string[] | null,
): Promise<PluginDetail> {
	const plugin = await requirePlugin(store, name);
	if (features !== null) {
		const known = new Set(Object.keys(plugin.manifest.features ?? {}));
		const unknown = features.filter((feature) => !known.has(feature));
		if (unknown.length > 0) {
			throw new PluginConfigError(`Unknown feature: ${unknown.join(", ")}`, 400);
		}
	}
	await store.setEnabledFeatures(name, features === null ? null : [...new Set(features)]);
	return getPluginConfig(store, name);
}

/** Returns a message when `value` does not fit `schema`; never echoes the value. */
function validateSetting(value: unknown, schema: PluginSettingSchema): string | undefined {
	switch (schema.type) {
		case "string":
			return typeof value === "string" ? undefined : "Expected string";
		case "boolean":
			return typeof value === "boolean" ? undefined : "Expected boolean";
		case "number": {
			if (typeof value !== "number" || Number.isNaN(value)) return "Expected number";
			if (schema.min !== undefined && value < schema.min) return `Must be >= ${schema.min}`;
			if (schema.max !== undefined && value > schema.max) return `Must be <= ${schema.max}`;
			return undefined;
		}
		case "enum":
			return typeof value === "string" && schema.values.includes(value)
				? undefined
				: `Must be one of: ${schema.values.join(", ")}`;
	}
}

/** `value: null` clears the stored value (the setting falls back to its default). */
export async function setPluginSetting(
	store: PluginStore,
	name: string,
	key: string,
	value: unknown,
): Promise<PluginDetail> {
	const plugin = await requirePlugin(store, name);
	const schema = plugin.manifest.settings?.[key];
	if (!schema) throw new PluginConfigError(`Unknown setting: ${key}`, 400);
	if (value === null) {
		await store.deletePluginSetting(name, key);
	} else {
		const problem = validateSetting(value, schema);
		if (problem) throw new PluginConfigError(`Invalid value for ${key}: ${problem}`, 400);
		await store.setPluginSetting(name, key, value);
	}
	return getPluginConfig(store, name);
}
