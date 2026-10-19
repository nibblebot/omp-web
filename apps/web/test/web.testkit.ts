/**
 * Shared /events transport double for the web store test files.
 *
 * connect() registers its SSE handler on a FakeEventSource; tests dispatch
 * frames through it exactly like the real stream and capture POSTed /command
 * bodies via a stubbed fetch. Bun's test runner has no browser globals, so the
 * stubs are installed per test by the importing file.
 *
 * Import ONLY from *.test.ts files: the stubs install onto process globals, so
 * a file that installs them should restore them (`restoreBrowserGlobals`) once
 * its own tests are done — otherwise they leak into sibling test files run in
 * the same process (`bun test a.ts b.ts` without --parallel).
 */
import type { ClientCommand, ServerFrame } from "#lib/wire/protocol";
import { SSE_EVENT_NAME } from "#lib/wire/protocol";
import { type Component, createComponent } from "solid-js";
import { ssrElement } from "solid-js/web";
import { state } from "../state";
import { pendingCalls } from "../store/transport";

type SseHandler = (ev: { data: string; lastEventId?: string }) => void;

export class FakeEventSource {
	static instances: FakeEventSource[] = [];
	static handlers = new Map<string, SseHandler>();
	onopen: (() => void) | null = null;
	/** Assigned by connect() like the real EventSource; tests invoke it. */
	onerror: (() => void) | null = null;
	constructor(public readonly url: string) {
		FakeEventSource.instances.push(this);
	}
	addEventListener(type: string, handler: SseHandler): void {
		FakeEventSource.handlers.set(type, handler);
	}
	close(): void {}
	/** Dispatch one SSE event; `lastEventId` mirrors native EventSource's
	 *  MessageEvent.lastEventId (the wire `id:` field, e.g. "1024"). */
	static dispatch(type: string, data: string, lastEventId?: string): void {
		FakeEventSource.handlers.get(type)?.({ data, lastEventId });
	}
}

/** POSTed /command bodies captured by the installed fetch stub. */
export const posted: ClientCommand[] = [];

export function attached(sessionId: string): ServerFrame {
	return { type: "attached", sessionId };
}

export function callResult(id: string, data: unknown, ok = true, error?: string): ServerFrame {
	return { type: "call_result", id, ok, data, ...(error !== undefined ? { error } : {}) };
}

export function dispatch(frame: ServerFrame): void {
	FakeEventSource.dispatch(SSE_EVENT_NAME, JSON.stringify(frame));
}

/** Dispatch one frame stamped with an SSE id (priming seqs 1..k or delta seqs >= SSE_DELTA_SEQ_START). */
export function dispatchSeq(frame: ServerFrame, seq: number): void {
	FakeEventSource.dispatch(SSE_EVENT_NAME, JSON.stringify(frame), String(seq));
}

export function userMsg(text: string): {
	role: "user";
	content: Array<{ type: "text"; text: string }>;
	timestamp: number;
} {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

export function assistantMsg(text: string): {
	role: "assistant";
	content: Array<{ type: "text"; text: string }>;
} {
	return { role: "assistant", content: [{ type: "text", text }] };
}

export function itemCounts(): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const item of state.items) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
	return counts;
}

export async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

/**
 * Install the browser globals the store's transport touches (the Bun test
 * runner has none) plus a fetch stub recording POST /command bodies in
 * `posted`, and reset the recorded transport state. Call from beforeEach.
 */
export function installTransportStubs(): void {
	posted.length = 0;
	FakeEventSource.instances.length = 0;
	FakeEventSource.handlers.clear();
	setBrowserGlobal("location", { search: "" } as Location);
	setBrowserGlobal("window", {
		setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
	} as unknown as Window & typeof globalThis);
	setBrowserGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
	setBrowserGlobal("fetch", (async (_input: unknown, init?: RequestInit) => {
		if (typeof init?.body === "string") posted.push(JSON.parse(init.body) as ClientCommand);
		return { ok: true, status: 202 } as Response;
	}) as unknown as typeof fetch);
}

/** Map-backed localStorage shim (fresh per call) for the slices that persist to it. */
export function installLocalStorageShim(): void {
	const storage = new Map<string, string>();
	setBrowserGlobal("localStorage", {
		getItem: (k: string) => storage.get(k) ?? null,
		setItem: (k: string, v: string) => void storage.set(k, v),
		removeItem: (k: string) => void storage.delete(k),
		clear: () => storage.clear(),
		key: (i: number) => [...storage.keys()][i] ?? null,
		get length() {
			return storage.size;
		},
	} as unknown as Storage);
}

type BrowserGlobal = "location" | "window" | "EventSource" | "fetch" | "localStorage" | "history";
type InstalledGlobal = { original: PropertyDescriptor | undefined; value: unknown };
const browserGlobals = new Map<string, InstalledGlobal>();
const jsxGlobals = new Map<string, InstalledGlobal>();

function installGlobal(installed: Map<string, InstalledGlobal>, key: string, value: unknown): void {
	const previous = installed.get(key);
	if (previous !== undefined && Reflect.get(globalThis, key) !== previous.value) {
		installed.delete(key);
	}
	const tracked = installed.get(key);
	const original =
		tracked === undefined ? Object.getOwnPropertyDescriptor(globalThis, key) : tracked.original;
	Reflect.set(globalThis, key, value);
	installed.set(key, { original, value });
}

function restoreGlobals(installed: Map<string, InstalledGlobal>): void {
	for (const [key, { original, value }] of installed) {
		if (Reflect.get(globalThis, key) !== value) continue;
		if (original === undefined) Reflect.deleteProperty(globalThis, key);
		else Object.defineProperty(globalThis, key, original);
	}
	installed.clear();
}

/** Track test-specific overrides too, without overwriting globals another harness owns. */
export function setBrowserGlobal<K extends BrowserGlobal>(
	key: K,
	value: (typeof globalThis)[K],
): void {
	installGlobal(browserGlobals, key, value);
}

/** Restore only the globals installed by this harness; safe to call repeatedly. */
export function restoreBrowserGlobals(): void {
	restoreGlobals(browserGlobals);
	dropPendingCalls();
}

/**
 * Forget calls a test left unanswered. Their replay and deadline timers would
 * otherwise fire inside a sibling test file; the promises stay pending, unsettled.
 */
function dropPendingCalls(): void {
	for (const pending of pendingCalls.values()) {
		clearTimeout(pending.timer);
		clearTimeout(pending.replayTimer);
	}
	pendingCalls.clear();
}

type JsxOptions = {
	onElement?: (type: unknown, props: Record<string, unknown>) => { value: unknown } | undefined;
};
const fragment = Symbol("Fragment");
const fragmentBinding = /^[A-Za-z_$][\w$]*/.exec(
	new Bun.Transpiler({ loader: "tsx" }).transformSync("<></>"),
)?.[0];

/** Bun's classic JSX transform over Solid's SSR primitives, shared by component tests. */
export function installJsxShim(options: JsxOptions = {}): void {
	if (jsxGlobals.size > 0) return;
	const createElement = (type: unknown, props: unknown, ...children: unknown[]): unknown => {
		const child = children.length <= 1 ? children[0] : children;
		const merged = { ...((props as Record<string, unknown>) ?? {}) };
		if (children.length > 0) merged.children = child;
		const intercepted = options.onElement?.(type, merged);
		if (intercepted !== undefined) return intercepted.value;
		if (type === fragment) return child;
		if (typeof type === "function") {
			return createComponent(type as Component<never>, merged as never);
		}
		return ssrElement(type as string, merged, children.length > 0 ? child : undefined, false);
	};
	installGlobal(jsxGlobals, "React", { createElement, Fragment: fragment });
	installGlobal(jsxGlobals, "Fragment", fragment);
	if (
		fragmentBinding !== undefined &&
		fragmentBinding !== "React" &&
		fragmentBinding !== "Fragment"
	) {
		installGlobal(jsxGlobals, fragmentBinding, fragment);
	}
}

export function restoreJsxShim(): void {
	restoreGlobals(jsxGlobals);
}
