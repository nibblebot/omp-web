import type { JSX } from "solid-js";
import type { state } from "../web/state";

/**
 * Store seed: either a patch of top-level store fields (applied with the real
 * `setState` after the store is reset to its pristine snapshot) or a function
 * that drives the real exported actions (`loadHistory`, `applyEvent`,
 * `pushToast`, ...). See seed.ts.
 */
export type StoreSeed = Partial<typeof state> | (() => void);

export interface StoryVariant {
	/** Short label shown above the rendered variant. */
	name: string;
	description?: string;
	/**
	 * Variant-specific store state. A story with any seeded variant is shown one
	 * variant at a time (the store is global), re-seeding on every switch.
	 */
	seed?: StoreSeed;
	render: () => JSX.Element;
}

/** The real component a story showcases, as the graph knows it. */
export interface ComponentRef {
	/** Repo-relative source file, e.g. "apps/web/components/ui/CopyButton.tsx". */
	file: string;
	/** Name the file exports the component under ("default" for a default export). */
	export: string;
}

export interface Story {
	/** URL-safe unique id, used as the hash route (`#/<id>`). */
	id: string;
	title: string;
	/**
	 * The real component(s) shown. Tier, group, children, and parents of a
	 * single component come from the component graph (graph.ts). A list makes
	 * one page for a family of components (every icon) and needs `section`.
	 */
	component: ComponentRef | ComponentRef[];
	/** Named page for a component family, listed with the primitives instead of in the App tree (e.g. "Icons"). */
	section?: string;
	/** Store state applied for every variant before rendering. */
	seed?: StoreSeed;
	/**
	 * Show one variant at a time even without variant seeds. Required for
	 * components that portal a full-screen overlay (Modal, ImageLightbox) so
	 * variants never stack on top of each other.
	 */
	tabs?: boolean;
	variants: StoryVariant[];
}

/** Identity helper that gives story modules contextual typing. */
export function defineStory(story: Story): Story {
	return story;
}
