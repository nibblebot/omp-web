import { createSignal } from "solid-js";
import type { PluginDetail, PluginSettingValue, PluginSummary } from "#lib/wire/protocol";
import { fleetSettingsActive, state } from "../state";
import { authedFetch } from "./auth";
import { trust } from "./integrations";
import { ctlError } from "./settings";
import { call } from "./transport";

/**
 * Installed-plugins domain. Fleet mode talks to /ctl/plugins/*; a session talks
 * to its plugin wire methods. Both write the same omp-plugins.lock.json.
 * Enabling a plugin runs its code with daemon permissions, so enable is
 * trust-gated exactly like the SkillsDialog install path.
 */

/** Card meta line, e.g. "Enabled · npm · v1.2.0". The version is omitted when absent. */
export function pluginMetaLine(plugin: PluginSummary): string {
	const parts = [plugin.enabled ? "Enabled" : "Disabled", plugin.source];
	if (plugin.version) parts.push(`v${plugin.version}`);
	return parts.join(" · ");
}

const [summaries, setSummaries] = createSignal<PluginSummary[]>([]);
const [detail, setDetail] = createSignal<PluginDetail | null>(null);
const [loading, setLoading] = createSignal(false);
const [error, setError] = createSignal<string | null>(null);

export const pluginSummaries = summaries;
export const pluginDetail = detail;
export const pluginsLoading = loading;
export const pluginsError = error;

function pluginPath(name: string): string {
	return `/ctl/plugins/${encodeURIComponent(name)}`;
}

async function fleetRequest<T>(path: string, body?: Record<string, unknown>): Promise<T> {
	const init: RequestInit =
		body === undefined
			? {}
			: {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				};
	const res = await (state.authStatus !== "disabled" ? authedFetch : fetch)(path, init);
	if (!res.ok) throw new Error(await ctlError(res));
	return (await res.json()) as T;
}

// Responses to a superseded session or mode are dropped, as in store/settings.ts.
function stillCurrent(sessionId: typeof state.currentSessionId, fleet: boolean): boolean {
	return sessionId === state.currentSessionId && fleet === fleetSettingsActive();
}

export function refreshPlugins(): void {
	const sessionId = state.currentSessionId;
	const fleet = fleetSettingsActive();
	setLoading(true);
	const load = fleet
		? fleetRequest<PluginSummary[]>("/ctl/plugins")
		: call("listPlugins", []).then((list) => list as PluginSummary[]);
	load
		.then((list) => {
			if (stillCurrent(sessionId, fleet)) setSummaries(list);
		})
		.catch((err: unknown) => {
			if (stillCurrent(sessionId, fleet)) setError(String(err));
		})
		.finally(() => setLoading(false));
}

export function openPlugin(name: string): void {
	const sessionId = state.currentSessionId;
	const fleet = fleetSettingsActive();
	setError(null);
	setDetail(null);
	const load = fleet
		? fleetRequest<PluginDetail>(pluginPath(name))
		: call("getPluginConfig", [name]).then((next) => next as PluginDetail);
	load
		.then((next) => {
			if (stillCurrent(sessionId, fleet)) setDetail(next);
		})
		.catch((err: unknown) => {
			if (stillCurrent(sessionId, fleet)) setError(String(err));
		});
}

export function closePlugin(): void {
	setDetail(null);
	setError(null);
}

function writePlugin(
	name: string,
	fleetRoute: "enabled" | "features" | "setting",
	fleetBody: Record<string, unknown>,
	method: "setPluginEnabled" | "setPluginFeatures" | "setPluginSetting",
	args: unknown[],
): void {
	const sessionId = state.currentSessionId;
	const fleet = fleetSettingsActive();
	setError(null);
	const write = fleet
		? fleetRequest<PluginDetail>(`${pluginPath(name)}/${fleetRoute}`, fleetBody)
		: call(method, args).then((next) => next as PluginDetail);
	write
		.then((next) => {
			if (!stillCurrent(sessionId, fleet)) return;
			setDetail(next);
			refreshPlugins();
		})
		.catch((err: unknown) => {
			if (stillCurrent(sessionId, fleet)) setError(String(err));
		});
}

/** Enabling runs plugin code, so it asks for trust first; disabling does not. */
export function setPluginEnabled(name: string, enabled: boolean): void {
	const apply = () =>
		writePlugin(name, "enabled", { enabled }, "setPluginEnabled", [name, enabled]);
	if (enabled) trust("Trust plugin code?", name, apply);
	else apply();
}

/** `null` restores manifest defaults; an array selects exactly those features. */
export function setPluginFeatures(name: string, features: string[] | null): void {
	writePlugin(name, "features", { features }, "setPluginFeatures", [name, features]);
}

/** `null` clears the stored value so the manifest default applies. */
export function setPluginSetting(
	name: string,
	key: string,
	value: PluginSettingValue | null,
): void {
	writePlugin(name, "setting", { key, value }, "setPluginSetting", [name, key, value]);
}
