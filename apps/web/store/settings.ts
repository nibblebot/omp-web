import type {
	SettingsItem,
	SettingsModel,
	SettingsRevisionAck,
	SettingValues,
} from "#lib/wire/protocol";
import { MAGIC_KEYWORDS } from "../prompt/magic-keywords";
import { APPEARANCE_SDK_SETTINGS } from "../prefs/settings";
import { fleetSettingsActive, setState, state } from "../state";
import { call } from "./transport";
import { reportError } from "./toasts";
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
// Settings model (TUI /settings parity). getSettings returns a fresh
// authoritative model, but only a sheet or the palette asks for it: an attach
// fetches just the boot paths. A session write asks for its revision only (the
// "revision" reply option): the full model is pushed once on settings_changed
// to every attached tab, and the write refetches it only if that push is behind
// the reply. With no session attached the /ctl settings endpoints back the panel
// instead (config.yml writes apply to new sessions); the session RPC resumes
// once a session is attached.
// ---------------------------------------------------------------------------
/**
 * Settings the page reads outside the Settings sheet, so every attach fetches
 * just these (`getSettings({ paths })`, a few hundred bytes) instead of the
 * 160 KB model: the transcript display prefs, composer, tool cards, the title
 * icons, collab and notification gates. `settingValue` of a path not listed
 * here only has an answer once the model has loaded, so a new reader outside
 * the sheet adds its path here (test/store/settings-paths.test.ts checks it).
 */
export const BOOT_SETTING_PATHS: readonly string[] = [
	...Object.values(APPEARANCE_SDK_SETTINGS).flat(),
	"mcp.renderMarkdownResults",
	"read.toolResultPreview",
	"readLineNumbers",
	"read.renderMarkdown",
	"spelling.autocomplete",
	"composer.predictions",
	"magicKeywords.enabled",
	...MAGIC_KEYWORDS.map((keyword) => `magicKeywords.${keyword.id}`),
	"paste.largeMenuThreshold",
	"emojiAutocomplete",
	"autocompleteMaxVisible",
	"display.subagentLivePreview",
	"title.icons",
	"tools.intentTracing",
	"collab.relayUrl",
	"completion.notify",
	"error.notify",
	"ask.notify",
	"btw.inject",
];

// What the full model reflects. It loads on first use (the sheets and the palette), not at attach,
// and stays current by the `settings_changed` push after that. An attach drops it (another session
// has its own revisions and option lists); whoever shows it next fetches it again. `modelStale`
// marks a held model whose revision the server has moved past (an edit from another page): it
// stops guarding against older revisions and is fetched again.
let modelStale = false;
// Mounted surfaces that render the model (the sheets); an attach or a revision move while any is
// open refetches it at once.
let modelHolders = 0;

/** True while the held model describes this attachment. */
function modelFresh(): boolean {
	return state.settingsModel !== null && !modelStale;
}

function targetMatches(target: SettingsModel["target"]): boolean {
	return (
		target === undefined ||
		target === (fleetSettingsActive() ? "future-sessions" : "current-session")
	);
}

/** Copy the boot paths' values out of a full model, so the readers of those paths follow it. */
function syncValuesFromModel(): void {
	const values: Record<string, unknown> = {};
	for (const path of BOOT_SETTING_PATHS) {
		const item = settingItem(path);
		if (item) values[path] = item.value;
	}
	setState("settingValues", values);
}

/** Apply RPC and pushed snapshots without letting older revisions replace newer ones. */
export function applySettingsModel(model: SettingsModel): void {
	if (!targetMatches(model.target)) return;
	const current = state.settingsModel;
	if (
		!modelStale &&
		current?.revision !== undefined &&
		(current.target === undefined || current.target === model.target) &&
		(model.revision === undefined || model.revision < current.revision)
	)
		return;
	modelStale = false;
	setState("settingsModel", model);
	syncValuesFromModel();
}

/** Apply the boot-path values of an attach; a revision the held model has not seen marks it stale. */
export function applySettingValues(result: SettingValues): void {
	if (!targetMatches(result.target)) return;
	if (modelFresh() && result.revision !== state.settingsModel?.revision) modelStale = true;
	setState("settingValues", result.values);
	if (modelStale && modelHolders > 0) refreshSettings();
}

let indexedTabs: SettingsModel["tabs"] | undefined;
let itemIndex = new Map<string, SettingsItem>();

/**
 * Effective value of a setting. A boot path reads the small attach fetch (or the model once it
 * has loaded), any other path only the model; undefined until one has it or for an unknown path.
 * The model's path index is rebuilt only when `tabs` is replaced (applySettingsModel is the sole
 * writer); values are read through the store, so callers in a tracking scope stay reactive.
 */
export function settingValue<T = unknown>(path: string): T | undefined {
	const attached = state.settingValues[path];
	if (attached !== undefined) return attached as T;
	return settingItem(path)?.value as T | undefined;
}

/** The model item behind a path; undefined until the model loads or for an unknown path. Reactive like `settingValue`. */
export function settingItem(path: string): SettingsItem | undefined {
	const tabs = state.settingsModel?.tabs;
	if (tabs !== indexedTabs) {
		itemIndex = new Map();
		for (const tab of tabs ?? [])
			for (const group of tab.groups)
				for (const item of group.items) itemIndex.set(item.path, item);
		indexedTabs = tabs;
	}
	return itemIndex.get(path);
}

let loadId = 0;
let valuesLoadId = 0;

/** Run a getSettings read on whichever surface backs settings now: the fleet's /ctl before a session attaches, the session's RPC after. */
function readSettings(options?: {
	paths: readonly string[];
}): Promise<SettingsModel | SettingValues> {
	if (!fleetSettingsActive())
		return call("getSettings", options ? [options] : []).then(
			(result) => result as SettingsModel | SettingValues,
		);
	const query = options ? `?paths=${encodeURIComponent(options.paths.join(","))}` : "";
	return fetch(`/ctl/settings${query}`).then(async (res) => {
		if (!res.ok) throw await ctlError(res);
		return (await res.json()) as SettingsModel | SettingValues;
	});
}

function applyRead(result: SettingsModel | SettingValues): void {
	// An older session or control plane ignores `paths` and answers the full model, which carries the same values.
	if ("tabs" in result) applySettingsModel(result);
	else applySettingValues(result);
}

/** Fetch the full model now (a write that went stale, or a surface that needs it). */
export function refreshSettings(): void {
	const id = ++loadId;
	const workspaceId = state.currentWorkspaceId;
	const fleet = fleetSettingsActive();
	setState("settingsLoading", true);
	readSettings()
		.then((model) => {
			if (workspaceId === state.currentWorkspaceId && fleet === fleetSettingsActive()) {
				applyRead(model);
			}
		})
		.catch((err) => {
			if (id === loadId) reportError(err);
		})
		.finally(() => {
			if (id === loadId) setState("settingsLoading", false);
		});
}

/** Fetch the boot paths' values only (the attach read). */
function refreshSettingValues(): void {
	const id = ++valuesLoadId;
	const workspaceId = state.currentWorkspaceId;
	const fleet = fleetSettingsActive();
	readSettings({ paths: BOOT_SETTING_PATHS })
		.then((result) => {
			if (workspaceId === state.currentWorkspaceId && fleet === fleetSettingsActive()) {
				applyRead(result);
			}
		})
		.catch((err) => {
			if (id === valuesLoadId) reportError(err);
		});
}

/**
 * A session attached (or the page booted with none): its settings are unknown. The held model
 * belongs to the previous attachment (its rows, option lists and revision), so it is dropped:
 * a sheet shows the loading note instead of editing it, and a write sends no stale revision.
 * Fetch the boot values, or the whole model when a sheet is open across the attach; the model
 * otherwise loads when something first shows it.
 */
export function settingsAttached(): void {
	setState("settingsModel", null);
	if (modelHolders > 0) refreshSettings();
	else refreshSettingValues();
}

/**
 * A surface that renders the full model (a sheet) mounted: load it unless it is already current,
 * and keep it current while mounted. Returns the release for `onCleanup`. A model already fresh is
 * only revalidated against the server's revision (the boot fetch, a few hundred bytes), so an
 * edit made elsewhere is picked up without refetching 160 KB.
 */
export function holdSettingsModel(): () => void {
	modelHolders++;
	if (!modelFresh()) {
		if (!state.settingsLoading) refreshSettings();
	} else refreshSettingValues();
	let released = false;
	return () => {
		if (released) return;
		released = true;
		modelHolders--;
	};
}

/** Load the full model if it is not current (the palette's settings rows); no revalidation. */
export function ensureSettingsModel(): void {
	if (!modelFresh() && !state.settingsLoading) refreshSettings();
}

/**
 * Writes run one at a time. Each waits for the previous response, so the
 * revision it sends is the one that response produced; rapid control changes
 * no longer share a stale revision and conflict with each other.
 */
let writeQueue: Promise<void> = Promise.resolve();

function isRevisionAck(result: SettingsModel | SettingsRevisionAck): result is SettingsRevisionAck {
	return !("tabs" in result);
}

function writeSetting(
	path: string,
	value: unknown,
	unset: boolean,
	expectedRevision: number | undefined,
	layer?: string,
): Promise<boolean> {
	const workspaceId = state.currentWorkspaceId;
	const fleet = fleetSettingsActive();
	const result = writeQueue
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
						unset
							? [path, revision, layer, "revision"]
							: [path, value, revision, layer, "revision"],
					).then((ack) => ack as SettingsRevisionAck);
			return request
				.then((result) => {
					if (workspaceId === state.currentWorkspaceId && fleet === fleetSettingsActive()) {
						if (isRevisionAck(result)) {
							// The session emits the pushed model before this reply; if it was lost in transit, refetch.
							if ((state.settingsModel?.revision ?? -1) < result.revision) refreshSettings();
						} else applySettingsModel(result);
					}
					return true;
				})
				.catch((err) => {
					if (workspaceId === state.currentWorkspaceId && fleet === fleetSettingsActive()) {
						reportError(err);
						// A rejected write (a revision conflict, for one) leaves this page's model stale; resync so the next write is current.
						refreshSettings();
					}
					return false;
				});
		})
		.catch((err) => {
			reportError(err);
			return false;
		});
	writeQueue = result.then(() => undefined);
	return result;
}

/**
 * Set an explicit value, including null; validation remains authoritative on the server.
 * Omit expectedRevision to write against the latest model; pass one to detect a stale draft (409).
 * Resolves true once the returned model is applied, false when the write failed (state.error holds why).
 */
export function updateSetting(
	path: string,
	value: unknown,
	expectedRevision?: number,
	layer?: string,
): Promise<boolean> {
	return writeSetting(path, value, false, expectedRevision, layer);
}

/** Remove an explicit override rather than storing null. Omit expectedRevision to write against the latest model. */
export function unsetSetting(
	path: string,
	expectedRevision?: number,
	layer?: string,
): Promise<boolean> {
	return writeSetting(path, undefined, true, expectedRevision, layer);
}
