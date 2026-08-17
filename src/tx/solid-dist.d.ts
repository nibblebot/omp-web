/**
 * Minimal ambient types for the solid-js client build used by
 * test/transcript-view.test.ts (bun resolves "solid-js" to its SSR build,
 * where memos never recompute — the reactive client build is needed to
 * assert recompute-once-per-entries-change behavior).
 */
declare module "solid-js/dist/solid.js" {
	export function createSignal<T>(value?: T): [() => T, (v: T | ((p: T) => T)) => void];
	export function createMemo<T>(fn: () => T, value?: T): () => T;
	export function createRoot<T>(fn: (dispose: () => void) => T): T;
}
