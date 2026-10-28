/**
 * Focus-return resolution shared by `Modal` and the menus that open dialogs.
 * A dialog opened from a menu item (or from a control that re-renders away)
 * must hand focus back somewhere sensible when it closes: the opener if it
 * survived, else the control registered for a removed ancestor, else a
 * page-wide fallback (the composer).
 */

/** The slice of an element the resolver needs; DOM elements satisfy it. */
export interface FocusNode {
	readonly isConnected: boolean;
	readonly parentElement: FocusNode | null;
	focus(): void;
}

const returnTargets = new WeakMap<object, () => FocusNode | null | undefined>();

/**
 * Declare that focus owned by `container` returns to `target()` once the
 * focused element has been removed (a closing menu hands focus to its trigger).
 */
export function registerFocusReturn(
	container: object,
	target: () => FocusNode | null | undefined,
): void {
	returnTargets.set(container, target);
}

/**
 * Pick the element to focus when a dialog closes. `origin` is where focus was
 * when it opened. A detached origin still links to its removed ancestors, so a
 * registered container above it can name the surviving trigger.
 */
export function resolveFocusReturn<T extends FocusNode>(
	origin: T | null,
	fallback: () => T | null,
): T | null {
	if (origin?.isConnected) return origin;
	for (let node: FocusNode | null = origin; node; node = node.parentElement) {
		const target = returnTargets.get(node)?.();
		if (target?.isConnected) return target as T;
	}
	const last = fallback();
	return last?.isConnected ? last : null;
}

// Weak: a closed dialog's focused element must not keep the whole detached dialog alive.
let lastFocused: WeakRef<HTMLElement> | null = null;

if (typeof document !== "undefined") {
	// Remembers the last focused element so a dialog opened right after its
	// opener was removed (a menu item closing its menu) still knows where
	// focus was.
	document.addEventListener(
		"focusin",
		(e) => {
			if (e.target instanceof HTMLElement && e.target !== lastFocused?.deref())
				lastFocused = new WeakRef(e.target);
		},
		true,
	);
}

/** Where focus was when a dialog opens: the active element, else the last one focused. */
export function focusOrigin(): HTMLElement | null {
	const active = document.activeElement;
	if (active instanceof HTMLElement && active !== document.body) return active;
	return lastFocused?.deref() ?? null;
}

/** Page-wide fallback target: the element marked `data-focus-fallback` (the composer). */
export function pageFocusFallback(): HTMLElement | null {
	return document.querySelector<HTMLElement>("[data-focus-fallback]");
}
