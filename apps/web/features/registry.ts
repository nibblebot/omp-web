import type { Component } from "solid-js";
import { type ChatItem, type ModalName, setState, state } from "../state";
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

/**
 * Typed extension slots a feature may fill. Core code reads slots only through
 * the accessors below, and only while the feature is active; a feature never
 * contributes anything to a page where it is disabled.
 */
export interface FeatureModule {
	id: FeatureId;
	/** Dialogs and sheets rendered by ModalHost for `state.modal === name`. */
	modals?: Partial<Record<ModalName, Component<{ onClose: () => void }>>>;
	/** Always-mounted overlays that render from their own store state (e.g. BTW sheet). */
	overlays?: readonly Component[];
	/** Slash commands handled locally. Names are declared in `manifest.ts`. */
	commands?: Readonly<Record<string, FeatureCommand>>;
	/** Analysis main view, mounted by App next to Chat. */
	view?: Component;
	/** Main pane header items, placed by MainHeader. */
	mainHeader?: { goalBadge?: Component };
	/** Sidebar header tool buttons, placed by SidebarHeader. */
	sidebarHeader?: { debugButton?: Component };
	/** Transcript item renderers keyed by ChatItem kind. */
	transcriptCards?: {
		[K in ChatItem["kind"]]?: Component<{ item: Extract<ChatItem, { kind: K }> }>;
	};
}

type Loader = () => Promise<{ default: FeatureModule }>;

/** Every feature entry is reached only through `import()`, so disabled features are never fetched. */
export const LOADERS: Record<FeatureId, Loader> = {
	analysis: () => import("./analysis"),
	review: () => import("./review"),
	integrations: () => import("./integrations"),
	plugins: () => import("./plugins"),
	btw: () => import("./btw"),
	goals: () => import("./goals"),
	advisor: () => import("./advisor"),
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

export function featureOverlays(): Component[] {
	return allActiveModules().flatMap((mod) => [...(mod.overlays ?? [])]);
}

export function featureMainHeader(): NonNullable<FeatureModule["mainHeader"]>[] {
	return allActiveModules().flatMap((mod) => (mod.mainHeader ? [mod.mainHeader] : []));
}

export function featureSidebarHeader(): NonNullable<FeatureModule["sidebarHeader"]>[] {
	return allActiveModules().flatMap((mod) => (mod.sidebarHeader ? [mod.sidebarHeader] : []));
}

/** Transcript renderer for one item kind from an active feature. */
export function featureTranscriptCard<K extends ChatItem["kind"]>(
	kind: K,
): Component<{ item: Extract<ChatItem, { kind: K }> }> | undefined {
	for (const mod of allActiveModules()) {
		const card = mod.transcriptCards?.[kind];
		if (card) return card;
	}
	return undefined;
}
