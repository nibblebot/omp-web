import type { Component } from "solid-js";
import { type ModalName, setState, state } from "../state";
import { pushToast } from "../store/toasts";
import { closeDock } from "../store/dock";
import { setView } from "../store/roster";
import {
	FEATURE_BY_ID,
	FEATURE_IDS,
	FEATURES,
	featureForCommand,
	featuresForModal,
	type FeatureId,
	type FeatureInfo,
} from "./manifest";
import {
	activeFeatureIds,
	markFeaturesActive,
	preferredFeatureIds,
	setFeaturePreference,
} from "./preferences";

/** A slash command owned by a feature; `run` receives the raw argument text. */
export interface FeatureCommand {
	/** One-line autocomplete description. */
	detail: string;
	run(args: string): void;
}

/** A right-dock panel shown by DockHost under the route's `<kind>` segment; features contribute theirs through `docks`. */
export interface DockPanel {
	title: string;
	body: Component;
	/** The body scrolls and pads itself (see DockPane `flush`). */
	flush?: boolean;
	/** Header controls beside the close button (DockPane `actions`). */
	actions?: Component;
}

/**
 * Typed extension slots a feature may fill. Core code reads slots only through
 * the accessors below, and only while the feature is active; a feature never
 * contributes anything to a page where it is disabled.
 */
export interface FeatureModule {
	id: FeatureId;
	/** Dialogs and sheets rendered by ModalHost for `state.modal === name`. */
	modals?: Partial<Record<ModalName, Component<{ onClose: () => void }>>>;
	/** Always-mounted overlays that render from their own store state. */
	overlays?: readonly Component[];
	/** Right-dock panels by kind. Kinds are declared in `manifest.ts` (`docks`). */
	docks?: Readonly<Record<string, DockPanel>>;
	/** Slash commands handled locally. Names are declared in `manifest.ts`. */
	commands?: Readonly<Record<string, FeatureCommand>>;
	/** Analysis main view, mounted by App next to Chat. */
	view?: Component;
	/** Control shown in this feature's own row in Settings > Features (e.g. an Open button). */
	settingsAction?: Component;
	/** Plugins tab body of the Extensions dialog; the dialog shows the tab only while a feature fills this. */
	pluginsTab?: Component;
}

type Loader = () => Promise<{ default: FeatureModule }>;

/** Every feature entry is reached only through `import()`, so disabled features are never fetched. */
export const LOADERS: Record<FeatureId, Loader> = {
	analysis: () => import("./analysis"),
	plan: () => import("./plan"),
	git: () => import("./git"),
	todos: () => import("./todos"),
	plugins: () => import("./plugins"),
	debug: () => import("./debug"),
};

const modules = new Map<FeatureId, FeatureModule>();

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

let activation = 0;

/**
 * Make exactly `ids` the active feature set for this page: load their entry
 * modules in parallel, then record which ones loaded. A feature whose module
 * fails to load stays inactive and raises a toast; the app keeps running.
 * Modules load once per page, so calling this again only changes the set,
 * and turning a feature off is just leaving it out (every slot accessor is
 * reactive on the active set). Calls can overlap while a toggle is still
 * loading; only the most recent call records its set, so a slow earlier
 * load never overwrites a later choice. Resolves to the set recorded, or
 * null when a newer call superseded this one.
 */
export async function activateFeatures(
	ids: readonly FeatureId[],
): Promise<ReadonlySet<FeatureId> | null> {
	const call = ++activation;
	const loaded = await Promise.all(
		ids.map(async (id) => {
			if (modules.has(id)) return id;
			try {
				const mod = (await LOADERS[id]()).default;
				if (mod.id !== id) throw new Error(`entry declares "${mod.id}"`);
				modules.set(id, mod);
				return id;
			} catch (error) {
				console.error(`feature "${id}" failed to load`, error);
				pushToast(
					`${FEATURE_BY_ID[id].label} could not load and stays off on this page: ${errorText(error)}`,
				);
				return null;
			}
		}),
	);
	if (call !== activation) return null;
	const active = loaded.filter((id): id is FeatureId => id !== null);
	markFeaturesActive(active);
	return new Set(active);
}

/**
 * Turn one feature on or off without a reload. The choice is persisted, the
 * feature's slots load or drop out immediately, and any modal, dock panel or
 * view it owned is closed. The attached session, draft and route are untouched.
 * Turning an "in-development" feature on is refused by `setFeaturePreference`,
 * so it is never persisted or loaded.
 */
export async function setFeatureEnabled(id: FeatureId, enabled: boolean): Promise<void> {
	setFeaturePreference(id, enabled);
	if ((await activateFeatures(preferredFeatureIds())) !== null) releaseDisabledSurfaces();
}

/** Close the modal, dock panel and view that a disabled feature owned, so nothing points at it. */
function releaseDisabledSurfaces(): void {
	const owners = state.modal === null ? [] : featuresForModal(state.modal);
	if (owners.length > 0 && !owners.some((f) => isFeatureEnabled(f.id))) setState("modal", null);
	const dock = state.dock?.kind;
	if (dock !== undefined && FEATURES.some((f) => f.docks.includes(dock) && !isFeatureEnabled(f.id)))
		closeDock();
	if (state.view === "analysis" && !isFeatureEnabled("analysis")) setView("chat");
}

/** True when the feature is active on this page (loaded and not disabled). */
export function isFeatureEnabled(id: FeatureId): boolean {
	return activeFeatureIds().has(id);
}

function activeModule(id: FeatureId): FeatureModule | undefined {
	return isFeatureEnabled(id) ? modules.get(id) : undefined;
}

function allActiveModules(): FeatureModule[] {
	return FEATURE_IDS.flatMap((id) => {
		const mod = activeModule(id);
		return mod ? [mod] : [];
	});
}

/**
 * Modal renderer from the first active feature that owns the modal, or undefined
 * when it is core or every owner is off.
 */
export function featureModal(name: ModalName): Component<{ onClose: () => void }> | undefined {
	for (const owner of featuresForModal(name)) {
		const renderer = activeModule(owner.id)?.modals?.[name];
		if (renderer) return renderer;
	}
	return undefined;
}

/** The dock panel for a kind owned by an active feature, or undefined when it is not a feature kind or every owner is off. */
export function featureDock(kind: string): DockPanel | undefined {
	for (const mod of allActiveModules()) {
		if (mod.docks !== undefined && Object.hasOwn(mod.docks, kind)) return mod.docks[kind];
	}
	return undefined;
}

/** The feature owning a slash name, and its handler, when that feature is active. */
export function featureCommand(
	name: string,
): { feature: FeatureInfo; command: FeatureCommand } | undefined {
	const feature = featureForCommand(name);
	if (!feature) return undefined;
	const command = activeModule(feature.id)?.commands?.[name];
	return command ? { feature, command } : undefined;
}

/** Autocomplete entries for active features, in manifest order. */
export function featureCommandDetails(): Array<[string, string]> {
	return allActiveModules().flatMap((mod) =>
		Object.entries(mod.commands ?? {}).map(([name, cmd]) => [name, cmd.detail] as [string, string]),
	);
}

/** Analysis main view, when Analysis mode is active. */
export function featureView(id: "analysis"): Component | undefined {
	return activeModule(id)?.view;
}

/** Plugins tab body for the Extensions dialog, when the plugins feature is active. */
export function featurePluginsTab(): Component | undefined {
	return activeModule("plugins")?.pluginsTab;
}

export function featureOverlays(): Component[] {
	return allActiveModules().flatMap((mod) => [...(mod.overlays ?? [])]);
}

/** The control a feature adds to its own row in Settings > Features, when the feature is active. */
export function featureSettingsAction(id: FeatureId): Component | undefined {
	return activeModule(id)?.settingsAction;
}
