import type { SettingsItem, SettingsModel } from "#lib/wire/protocol";
import { fleetSettingsActive, setState, state } from "../state";
import { call } from "./transport";
import { authedFetch } from "./auth";

/**
 * Settings domain (Phase 3 store facade split): TUI /settings parity. The
 * settings mirror (state.settingsModel/settingsLoading, settings_changed
 * frames) stays in state.ts alongside the mux.
 */

/** Server error message from a non-ok /ctl response: the {error} body when
 *  present, else the raw body text, else the HTTP status. */
export async function ctlError(res: Response): Promise<string> {
	const body = await res.text().catch(() => "");
	try {
		const parsed = JSON.parse(body) as { error?: unknown };
		if (typeof parsed.error === "string" && parsed.error !== "") return parsed.error;
	} catch {
		// non-JSON body, so fall through to the raw text
	}
	return body || String(res.status);
}

// ---------------------------------------------------------------------------
// Settings model (TUI /settings parity). getSettings/setSetting return a
// fresh authoritative model each time; settings_changed frames keep every
// tab's settings panel in sync. With no daemon attached the /ctl settings
// endpoints back the panel instead (config.yml writes apply to new
// sessions); the session RPC resumes once a session is attached.
// ---------------------------------------------------------------------------
/** Apply RPC and pushed snapshots without letting older revisions replace newer ones. */
export function applySettingsModel(model: SettingsModel): void {
	const target = fleetSettingsActive() ? "future-sessions" : "current-session";
	if (model.target !== undefined && model.target !== target) return;
	const current = state.settingsModel;
	if (
		current?.revision !== undefined &&
		(current.target === undefined || current.target === model.target) &&
		(model.revision === undefined || model.revision < current.revision)
	)
		return;
	setState("settingsModel", model);
}

let indexedTabs: SettingsModel["tabs"] | undefined;
let itemIndex = new Map<string, SettingsItem>();

/**
 * Effective value of a setting from the authoritative model. Undefined until the model loads or for an unknown path.
 * The path index is rebuilt only when `tabs` is replaced (applySettingsModel is the sole writer); values are read
 * through the store items, so callers in a tracking scope stay reactive.
 */
export function settingValue<T = unknown>(path: string): T | undefined {
	const tabs = state.settingsModel?.tabs;
	if (tabs !== indexedTabs) {
		itemIndex = new Map();
		for (const tab of tabs ?? [])
			for (const group of tab.groups)
				for (const item of group.items) itemIndex.set(item.path, item);
		indexedTabs = tabs;
	}
	return itemIndex.get(path)?.value as T | undefined;
}

let loadId = 0;

export function refreshSettings(): void {
	const id = ++loadId;
	const sessionId = state.currentSessionId;
	const fleet = fleetSettingsActive();
	setState("settingsLoading", true);
	const load = fleet
		? fetch("/ctl/settings").then(async (res) => {
				if (!res.ok) throw await ctlError(res);
				return (await res.json()) as SettingsModel;
			})
		: call("getSettings", []).then((m) => m as SettingsModel);
	load
		.then((model) => {
			if (sessionId === state.currentSessionId && fleet === fleetSettingsActive()) {
				applySettingsModel(model);
			}
		})
		.catch((err) => {
			if (id === loadId) setState("error", String(err));
		})
		.finally(() => {
			if (id === loadId) setState("settingsLoading", false);
		});
}

/**
 * Writes run one at a time. Each waits for the previous response, so the
 * revision it sends is the one that response produced; rapid control changes
 * no longer share a stale revision and conflict with each other.
 */
let writeQueue: Promise<void> = Promise.resolve();

function writeSetting(
	path: string,
	value: unknown,
	unset: boolean,
	expectedRevision: number | undefined,
	layer?: string,
): void {
	const sessionId = state.currentSessionId;
	const fleet = fleetSettingsActive();
	writeQueue = writeQueue
		.then(() => {
			// Resolved at dispatch: an omitted revision means the latest model, not the one current at the call.
			const revision = expectedRevision ?? state.settingsModel?.revision;
			const request = fleet
				? (state.authStatus !== "disabled" ? authedFetch : fetch)(
						unset ? "/ctl/settings/unset" : "/ctl/settings/set",
						{
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify(
								unset
									? { path, expectedRevision: revision, layer }
									: { path, value, expectedRevision: revision, layer },
							),
						},
					).then(async (res) => {
						if (!res.ok) throw await ctlError(res);
						return (await res.json()) as SettingsModel;
					})
				: call(
						unset ? "unsetSetting" : "setSetting",
						unset ? [path, revision, layer] : [path, value, revision, layer],
					).then((model) => model as SettingsModel);
			return request
				.then((model) => {
					if (sessionId === state.currentSessionId && fleet === fleetSettingsActive()) {
						applySettingsModel(model);
					}
				})
				.catch((err) => {
					if (sessionId === state.currentSessionId && fleet === fleetSettingsActive()) {
						setState("error", String(err));
					}
				});
		})
		.catch((err) => setState("error", String(err)));
}

/**
 * Set an explicit value, including null; validation remains authoritative on the server.
 * Omit expectedRevision to write against the latest model; pass one to detect a stale draft (409).
 */
export function updateSetting(
	path: string,
	value: unknown,
	expectedRevision?: number,
	layer?: string,
): void {
	writeSetting(path, value, false, expectedRevision, layer);
}

/** Remove an explicit override rather than storing null. Omit expectedRevision to write against the latest model. */
export function unsetSetting(path: string, expectedRevision?: number, layer?: string): void {
	writeSetting(path, undefined, true, expectedRevision, layer);
}
