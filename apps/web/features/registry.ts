import type { Component } from "solid-js";
import type { ChatItem, ModalName } from "../state";
import { pushToast } from "../store/toasts";
import {
	FEATURE_BY_ID,
	FEATURE_IDS,
	featureForCommand,
	featureForModal,
	type FeatureId,
	type FeatureInfo,
} from "./manifest";
import { activeFeatureIds, markFeaturesActive } from "./preferences";

/** A slash command owned by a feature; `run` receives the raw argument text. */
export interface FeatureCommand {
	/** One-line autocomplete description. */
	detail: string;
	run(args: string): void;
}

/** One tab in the subagents hub. Lower `rank` renders first; the core Workers tab is 0. */
export interface SubagentTab {
	id: string;
	label: string;
	rank: number;
	panel: Component;
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
	/** Extra tabs in the subagents hub. */
	subagentTabs?: readonly SubagentTab[];
	/** Transcript item renderers keyed by ChatItem kind. */
	transcriptCards?: {
		[K in ChatItem["kind"]]?: Component<{ item: Extract<ChatItem, { kind: K }> }>;
	};
}

type Loader = () => Promise<{ default: FeatureModule }>;

/** Every feature entry is reached only through `import()`, so disabled features are never fetched. */
const LOADERS: Record<FeatureId, Loader> = {
	analysis: () => import("./analysis"),
	review: () => import("./review"),
	integrations: () => import("./integrations"),
	btw: () => import("./btw"),
	goals: () => import("./goals"),
	advisor: () => import("./advisor"),
	debug: () => import("./debug"),
};

const modules = new Map<FeatureId, FeatureModule>();

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Make exactly `ids` the active feature set for this page: load their entry
 * modules in parallel, then record which ones loaded. A feature whose module
 * fails to load stays inactive and raises a toast; the app keeps running.
 * Modules load once per page, so calling this again only changes the set.
 */
export async function activateFeatures(ids: readonly FeatureId[]): Promise<void> {
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
	markFeaturesActive(loaded.filter((id): id is FeatureId => id !== null));
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

/** Modal renderer owned by a feature, or undefined when it is core or the feature is off. */
export function featureModal(name: ModalName): Component<{ onClose: () => void }> | undefined {
	const owner = featureForModal(name);
	return owner ? activeModule(owner.id)?.modals?.[name] : undefined;
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

/** Hub tabs contributed by active features, sorted by rank. */
export function featureSubagentTabs(): SubagentTab[] {
	return allActiveModules()
		.flatMap((mod) => [...(mod.subagentTabs ?? [])])
		.sort((a, b) => a.rank - b.rank);
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
