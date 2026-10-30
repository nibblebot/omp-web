/**
 * Shared browser-socket transport double for the web store test files.
 *
 * connect() dials a FakeWebSocket; tests open it (`onopen`), deliver server
 * messages through it exactly like the real socket, and read the commands the
 * client sent in `posted`. The fake acks every command at once unless a test
 * turns `autoAck` off. Bun's test runner has no browser globals, so the stubs
 * are installed per test by the importing file.
 *
 * Import ONLY from *.test.ts files: the stubs install onto process globals, so
 * a file that installs them should restore them (`restoreBrowserGlobals`) once
 * its own tests are done — otherwise they leak into sibling test files run in
 * the same process (`bun test a.ts b.ts` without --parallel).
 */
import {
	ackMessage,
	frameMessage,
	nackMessage,
	pingMessage,
	seqFrameMessage,
} from "#lib/wire/browser-socket";
import type { ClientCommand, ServerFrame } from "#lib/wire/protocol";
import { type Component, createComponent } from "solid-js";
import { unwrap } from "solid-js/store";
import { ssrElement } from "solid-js/web";
import { resetBrowserSocket, setState, state } from "../state";
import { rejectPendingCalls } from "../store/transport";

/** Commands the client sent over the fake socket, in order (re-sends included). */
export const posted: ClientCommand[] = [];

export class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	/** Ack every command at once, as the server does for an accepted command. */
	static autoAck = true;
	/** Answer each command itself (ack, nack, hold, answer with a frame); replaces autoAck while set. */
	static reply: ((cmd: ClientCommand, ws: FakeWebSocket) => void) | null = null;
	/** Assigned by connect() like the real WebSocket; tests invoke `onopen?.()`. */
	onopen: (() => void) | null = null;
	onmessage: ((ev: { data: unknown }) => void) | null = null;
	onclose: ((ev: { code: number; reason: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	/** Raw text messages the client sent (each a `{"cmd":...}`). */
	readonly sent: string[] = [];
	/** How the client closed this socket, or null while it has not. */
	closed: { code?: number; reason?: string } | null = null;
	constructor(public readonly url: string) {
		FakeWebSocket.instances.push(this);
	}
	send(data: string): void {
		this.sent.push(data);
		const { cmd } = JSON.parse(data) as { cmd: ClientCommand };
		posted.push(cmd);
		if (FakeWebSocket.reply !== null) FakeWebSocket.reply(cmd, this);
		else if (FakeWebSocket.autoAck) this.ack(cmd.id);
	}
	/** Ack one command, as the server does for an accepted command. */
	ack(id: string): void {
		this.message(ackMessage(id));
	}
	close(code?: number, reason?: string): void {
		this.closed = { code, reason };
	}
	/** Deliver one raw server message to the client. */
	message(text: unknown): void {
		this.onmessage?.({ data: text });
	}
	/** Nack one command, as the server does for a refused one. */
	nack(id: string, status: number, error: string): void {
		this.message(nackMessage(id, status, error));
	}
	ping(): void {
		this.message(pingMessage(Date.now()));
	}
	/** The server (or the network) closes the socket. */
	serverClose(code: number, reason = ""): void {
		this.onclose?.({ code, reason });
	}
	/** Deliver a raw message on the newest socket. */
	static deliver(text: unknown): void {
		FakeWebSocket.instances.at(-1)?.message(text);
	}
}

export function attached(scope: string): ServerFrame {
	return { type: "attached", scope };
}

export function callResult(id: string, data: unknown, ok = true, error?: string): ServerFrame {
	return { type: "call_result", id, ok, data, ...(error !== undefined ? { error } : {}) };
}

/** Deliver one frame as the server's unsequenced `{"frame":...}` message. */
export function dispatch(frame: ServerFrame): void {
	FakeWebSocket.deliver(frameMessage(JSON.stringify(frame)));
}

/** Deliver one frame stamped with a seq (priming seqs 1..k or delta seqs >= DELTA_SEQ_START). */
export function dispatchSeq(frame: ServerFrame, seq: number): void {
	FakeWebSocket.deliver(seqFrameMessage(seq, JSON.stringify(frame)));
}

/**
 * Hold every command of `type` unanswered until its `settle` runs (ack when
 * ok, else nack 500); every other command is acked at once. Install before the
 * command is sent.
 */
export function holdCommands(
	type: ClientCommand["type"],
): Array<{ cmd: ClientCommand; settle: (ok: boolean) => void }> {
	const held: Array<{ cmd: ClientCommand; settle: (ok: boolean) => void }> = [];
	FakeWebSocket.reply = (cmd, ws) => {
		if (cmd.type !== type) {
			ws.ack(cmd.id);
			return;
		}
		held.push({ cmd, settle: (ok) => (ok ? ws.ack(cmd.id) : ws.nack(cmd.id, 500, "refused")) });
	};
	return held;
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
 * runner has none) plus a fetch stub for the HTTP endpoints, and reset the
 * recorded transport state, including the page's socket resume state. Call
 * from beforeEach.
 */
export function installTransportStubs(): void {
	rememberStoreKeys();
	resetBrowserSocket();
	dropPendingCalls(); // a fresh page has no calls in flight, even after a sibling file that left some
	posted.length = 0;
	FakeWebSocket.instances.length = 0;
	FakeWebSocket.autoAck = true;
	FakeWebSocket.reply = null;
	setBrowserGlobal("location", { search: "", origin: "http://localhost" } as Location);
	setBrowserGlobal("window", {
		setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
	} as unknown as Window & typeof globalThis);
	setBrowserGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
	setBrowserGlobal(
		"fetch",
		(async () => ({ ok: true, status: 200 }) as Response) as unknown as typeof fetch,
	);
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

type BrowserGlobal = "location" | "window" | "WebSocket" | "fetch" | "localStorage" | "history";
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
	resetBrowserSocket();
	restoreGlobals(browserGlobals);
	dropPendingCalls();
	restoreStoreKeys();
}

/** Top-level store values as they stood before this file's first transport stub; null once handed back. */
let storeKeys: Record<string, unknown> | null = null;

function rememberStoreKeys(): void {
	storeKeys ??= { ...unwrap(state) };
}

/**
 * A sparse `state` frame (a test delivers only the fields it cares about) sets the rest to
 * undefined, and a Solid store drops a key set to undefined. Hand back each such key with the
 * value it had before the file ran, so a later file in the same process finds the store shape
 * it expects (every field the store declares).
 */
function restoreStoreKeys(): void {
	if (storeKeys === null) return;
	const present = unwrap(state) as Record<string, unknown>;
	const dropped: Record<string, unknown> = {};
	for (const key of Object.keys(storeKeys)) {
		if (!(key in present)) dropped[key] = storeKeys[key];
	}
	storeKeys = null;
	if (Object.keys(dropped).length > 0) setState(dropped);
}

/**
 * Fail the calls a test left unanswered, as a dropped page does. Their replay and deadline
 * timers would otherwise fire inside a sibling test file, and a call that never settles keeps
 * its caller's module-global bookkeeping (the shared job poll's flight) stuck for every later
 * file in the same process.
 */
function dropPendingCalls(): void {
	rejectPendingCalls(new Error("test page dropped"));
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
