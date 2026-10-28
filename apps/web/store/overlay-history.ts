/**
 * Browser-history bookkeeping so the Android Back gesture dismisses what is on
 * top before it navigates routes.
 *
 * Open layers (popovers, menus, modals and sheets, the lightbox, a danger
 * confirm, a narrow-viewport sidebar drawer) each register with
 * `openOverlayLayer`. A registered layer owns one same-URL "sentinel" history
 * entry. Back pops that entry, `onPopState` finds the topmost layer and asks it
 * to close. Closing a layer from its own UI removes it from the stack; the
 * surplus sentinel is then consumed with `history.go` so history does not grow
 * (and a later Back does not land on a dead entry).
 *
 * A same-URL entry fires `popstate` but not `hashchange`, so the route restore
 * in store/deep-link.ts never runs for a sentinel pop. Entry counts, not entry
 * identity, drive the bookkeeping: all sentinels are interchangeable.
 *
 * Route writes must not land above a sentinel (a later consume would then walk
 * back across the route). `atBaseEntry` pops the sentinels first, runs the
 * write, and `reconcile` pushes them back on top of the new entry.
 *
 * The dock rides the URL (route restore handles Back). The one extra here is
 * its entry depth: `history.state.ompDock` counts the entries pushed while one
 * dock stayed open on the same session, so closing it from its UI can unwind
 * them (`unwindDockEntries`) instead of leaving entries that Back reopens.
 */

/** Marker keys in `history.state`. */
interface EntryState {
	/** 1-based depth of an overlay sentinel entry above the base entry. */
	ompOverlay?: number;
	/** Entries pushed since the dock opened on this session, this one included. */
	ompDock?: number;
}

interface Layer {
	close: () => void;
}

interface Traversal {
	onSettled?: () => void;
	timer: ReturnType<typeof setTimeout>;
}

/** A `history.go` that never fires `popstate` (clamped at the ends) must not wedge the queue. */
const TRAVERSAL_TIMEOUT_MS = 1000;

/** Open layers, topmost last. */
const layers: Layer[] = [];
/** Sentinel entries currently above the base entry. */
let entries = 0;
let reconcileScheduled = false;
/** `history.go` calls whose `popstate` has not arrived yet. */
const traversals: Traversal[] = [];
/** Callers waiting for every traversal to settle. */
let waiters: (() => void)[] = [];

const hasHistory = (): boolean => typeof history !== "undefined" && typeof location !== "undefined";

function entryState(): EntryState {
	const raw: unknown = history.state;
	return typeof raw === "object" && raw !== null ? (raw as EntryState) : {};
}

/** Dock entry depth of the current history entry; 0 when it did not open or retarget a dock. */
export function dockEntryDepth(): number {
	if (!hasHistory()) return 0;
	const depth = entryState().ompDock;
	return typeof depth === "number" && depth > 0 ? depth : 0;
}

/** `history.state` for a route entry: the dock depth marker, nothing else. */
export function routeEntryState(dockDepth: number): EntryState | null {
	return dockDepth > 0 ? { ompDock: dockDepth } : null;
}

/**
 * Forget sentinels that are no longer the current entry: foreign code (a plain
 * `location.hash` write, a route push) landed a new entry on top of them, and
 * walking back over it would navigate. The open layers get fresh sentinels
 * from `reconcile`.
 */
function dropBuriedEntries(): void {
	if (entries > 0 && entryState().ompOverlay !== entries) entries = 0;
}

function schedule(): void {
	if (reconcileScheduled) return;
	reconcileScheduled = true;
	queueMicrotask(reconcile);
}

/** Bring the sentinel entries in line with the open layers. Waits while a traversal is in flight. */
function reconcile(): void {
	reconcileScheduled = false;
	if (traversals.length > 0 || !hasHistory()) return;
	dropBuriedEntries();
	while (entries < layers.length) {
		entries++;
		history.pushState(
			{ ...entryState(), ompOverlay: entries } satisfies EntryState,
			"",
			location.href,
		);
	}
	if (entries > layers.length) {
		const surplus = entries - layers.length;
		entries = layers.length;
		traverse(-surplus);
	}
}

function traverse(delta: number, onSettled?: () => void): void {
	const traversal: Traversal = {
		onSettled,
		timer: setTimeout(() => settle(traversal), TRAVERSAL_TIMEOUT_MS),
	};
	traversals.push(traversal);
	history.go(delta);
}

function settle(traversal: Traversal): void {
	const index = traversals.indexOf(traversal);
	if (index < 0) return;
	traversals.splice(index, 1);
	clearTimeout(traversal.timer);
	traversal.onSettled?.();
	if (traversals.length > 0) return;
	const ready = waiters;
	waiters = [];
	for (const fn of ready) fn();
	schedule();
}

/** True while a history traversal this module started has not finished. */
export function isHistoryTraversing(): boolean {
	return traversals.length > 0;
}

/** Run `fn` now, or once every in-flight traversal has settled. */
export function afterHistorySettles(fn: () => void): void {
	if (traversals.length === 0) fn();
	else waiters.push(fn);
}

/**
 * Register an open layer. `close` is called when Back pops the layer (it must
 * close the UI). Returns a `dismiss` for the UI close path; it is idempotent
 * and a no-op once Back already popped the layer.
 */
export function openOverlayLayer(close: () => void): () => void {
	const layer: Layer = { close };
	layers.push(layer);
	schedule();
	return () => {
		const index = layers.indexOf(layer);
		if (index < 0) return;
		layers.splice(index, 1);
		schedule();
	};
}

/**
 * `popstate` handler. A traversal this module started settles; otherwise a
 * sentinel was popped and the topmost layer closes. With neither, Back is a
 * route navigation and `hashchange` (store/deep-link.ts) handles it.
 */
export function onPopState(): void {
	const started = traversals[0];
	if (started !== undefined) {
		settle(started);
		return;
	}
	const top = layers.pop();
	if (top === undefined) {
		entries = 0;
		return;
	}
	entries = Math.max(0, entries - 1);
	top.close();
	schedule();
}

/** Listen for Back. Returns the removal. */
export function installOverlayHistory(): () => void {
	window.addEventListener("popstate", onPopState);
	return () => window.removeEventListener("popstate", onPopState);
}

/**
 * Run a route write on the base entry. Sentinels above it are popped first and
 * come back afterwards, so the write never strands them below a new entry.
 */
export function atBaseEntry(write: () => void): void {
	if (traversals.length > 0) {
		waiters.push(() => atBaseEntry(write));
		return;
	}
	if (hasHistory()) dropBuriedEntries();
	if (entries === 0 || !hasHistory()) {
		write();
		schedule();
		return;
	}
	const surplus = entries;
	entries = 0;
	traverse(-surplus, write);
}

/**
 * The user closed the dock from its UI: step back over the entries pushed while
 * it was open, so Back does not reopen it. Call BEFORE the dock state changes:
 * the route sync then waits for the traversal and finds the URL already
 * dock-less. A dock whose entries are not all ours (depth 0) is left to the
 * route sync, which rewrites the entry in place.
 */
export function unwindDockEntries(): void {
	if (!hasHistory()) return;
	atBaseEntry(() => {
		const depth = dockEntryDepth();
		if (depth > 0) traverse(-depth);
	});
}
