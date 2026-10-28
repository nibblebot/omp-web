import { createComponent, lazy, type Component } from "solid-js";

/** A component whose module is fetched on first render, not with the entry chunk. */
export type LazyComponent<P extends Record<string, any>> = Component<P> & {
	/** Fetch the module now (hover, idle) and resolve to the component it exports. */
	preload(): Promise<Component<P>>;
};

/**
 * Defer a component's module to its first render: `load` is an `import()`
 * returning the component. Nothing renders until the module arrives, so the
 * caller (ModalHost) sits under an ErrorBoundary for a failed fetch. Unlike
 * Solid's `lazy`, a failed load is forgotten, so the next render retries
 * instead of replaying the rejection forever, and a loaded component mounts
 * synchronously.
 */
export function lazyComponent<P extends Record<string, any>>(
	load: () => Promise<Component<P>>,
): LazyComponent<P> {
	let loaded: Component<P> | undefined;
	let pending: Promise<Component<P>> | undefined;
	const preload = (): Promise<Component<P>> =>
		(pending ??= load().then(
			(component) => (loaded = component),
			(error: unknown) => {
				pending = undefined;
				throw error;
			},
		));
	// Solid's lazy memoizes its own promise for good, so each mount builds a fresh one over the shared load.
	const Lazy: LazyComponent<P> = Object.assign(
		(props: P) =>
			createComponent(
				loaded ?? lazy(() => preload().then((component) => ({ default: component }))),
				props,
			),
		{ preload },
	);
	return Lazy;
}
