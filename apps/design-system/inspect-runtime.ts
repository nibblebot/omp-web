import type { Component, JSX } from "solid-js";
import {
	children,
	type ChildrenReturn,
	createComputed,
	getOwner,
	mergeProps,
	onCleanup,
	untrack,
	type Owner,
} from "solid-js";
import { createComponent as solidCreateComponent, Portal } from "solid-js/web";

/**
 * Runtime behind the design system's component inspector.
 *
 * solid-plugin.ts points babel-preset-solid's `moduleName` here, so every
 * compiled module imports its helpers (`template`, `insert`, `createComponent`,
 * ...) from this file. Everything is re-exported untouched from `solid-js/web`
 * except `createComponent`, which is shadowed to record which registered apps/web
 * components are mounted and which DOM nodes each one currently renders.
 *
 * This file stays plain `.ts` on purpose: the Babel pass only handles
 * `.tsx`/`.jsx`, so the runtime never imports itself.
 */
export * from "solid-js/web";

/** Registered component function -> graph node id (`<repo-relative file>#<local name>`). */
const ids = new WeakMap<object, string>();
const live = new Set<Instance>();
/** Per-instance owner -> instance, so a component created anywhere below it finds its parent. */
const byOwner = new WeakMap<Owner, Instance>();
let inspecting = false;

export interface ComponentInstance {
	/** Graph node id. */
	readonly id: string;
	/** The tracked component whose subtree created this one (owner tree, so portals and list rows count); null at the top. */
	readonly parent: ComponentInstance | null;
	/** The instance's current top-level DOM nodes (resolved output; may include Text nodes or be empty). */
	nodes(): Node[];
	/** Containers of the `<Portal>`s this instance renders (nearest tracked owner), mounted under `<body>`. */
	portals(): Element[];
}

interface Instance extends ComponentInstance {
	readonly parent: Instance | null;
	nodes: () => Node[];
	readonly portalSet: Set<Element>;
}

/** Called by generated code once per component declaration at the end of each apps/web module. */
export function registerComponent(fn: unknown, id: string): void {
	if (typeof fn !== "function" || ids.has(fn)) return;
	ids.set(fn, id);
}

/** Components created while on are tracked; components created while off are left untouched. */
export function setInspecting(on: boolean): void {
	inspecting = on;
}

/**
 * Live mounted instances in creation order. A parent is added before the
 * children its body creates. Entries disappear when their owner is cleaned up.
 * Read synchronously (for example in a rAF loop); not reactive.
 */
export function mountedInstances(): Iterable<ComponentInstance> {
	return live;
}

/** Whether `inst` is still mounted. */
export function isMounted(inst: ComponentInstance): boolean {
	return live.has(inst as Instance);
}

/** Portal container element -> the tracked component that rendered the `<Portal>`. */
const portalOwners = new WeakMap<Node, Instance>();

/**
 * The tracked component that rendered the innermost portal holding `node`, or
 * null outside portals. Portaled content (modals, sheets) sits under `<body>`,
 * outside every tracked instance's own nodes; this ties it back to its tree.
 */
export function portalOf(node: Node): ComponentInstance | null {
	for (let at: Node | null = node; at !== null; at = at.parentNode) {
		const owner = portalOwners.get(at);
		if (owner !== undefined) return owner;
	}
	return null;
}

/**
 * Drop-in replacement for solid's `createComponent`. Unregistered components,
 * and every component created while inspection is off, take the plain path.
 *
 * The output goes through `children()` because it is Solid's sanctioned
 * memoized resolver: it evaluates the returned accessors and nested arrays
 * exactly once and tracks later changes. Calling the raw output functions again
 * to find DOM nodes could recreate the DOM. The resolved memo accessor is
 * returned in place of the raw output, and `insert` treats it as a reactive
 * child, so the DOM is the same.
 *
 * The body runs inside an untracked computation that never re-runs: a per-instance
 * owner, which is what Solid's dev build creates for every component. It
 * inherits context like any computation and is disposed with its parent.
 * Mapping it to the instance lets components created later in its subtree
 * (list rows, `Show` branches, portaled modal content) find their parent by
 * walking the owner chain.
 *
 * A `<Portal>` created while inspecting gets a `ref` (Solid's Portal calls it
 * with its container; a caller's own ref still runs) that records the
 * container against the nearest tracked instance; see `portalOf`.
 */
export function createComponent<T extends Record<string, any>>(
	Comp: Component<T>,
	props: T,
): JSX.Element {
	const id = inspecting ? ids.get(Comp) : undefined;
	if (id === undefined && !(inspecting && (Comp as unknown) === Portal)) {
		return solidCreateComponent(Comp, props);
	}
	let parent: Instance | null = null;
	for (let owner = getOwner(); owner !== null && parent === null; owner = owner.owner) {
		parent = byOwner.get(owner) ?? null;
	}
	if (id === undefined) {
		if (parent === null) return solidCreateComponent(Comp, props);
		const owner = parent;
		const callerRef: unknown = props.ref;
		// Portal calls `ref` inside its render effect, so the cleanup runs when the container is removed.
		const ref = (el: Element) => {
			portalOwners.set(el, owner);
			owner.portalSet.add(el);
			onCleanup(() => owner.portalSet.delete(el));
			if (typeof callerRef === "function") callerRef(el);
		};
		const merged = mergeProps(props, { ref }) as T;
		return solidCreateComponent(Comp, merged);
	}
	// Registered before the body runs so parents precede their children.
	const inst: Instance = {
		id,
		parent,
		nodes: () => [],
		portalSet: new Set(),
		portals: () => [...inst.portalSet],
	};
	live.add(inst);
	let resolved: ChildrenReturn | undefined;
	// Runs synchronously, once: nothing inside is tracked.
	createComputed(() =>
		untrack(() => {
			const owner = getOwner();
			if (owner !== null) byOwner.set(owner, inst);
			onCleanup(() => live.delete(inst));
			const out = solidCreateComponent(Comp, props);
			resolved = children(() => out);
		}),
	);
	const output = resolved as ChildrenReturn;
	inst.nodes = () => output.toArray().filter((n): n is Node => n instanceof Node);
	return output as unknown as JSX.Element;
}
