import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OMP_PROTO, SSE_EVENT_NAME } from "../../../../lib/wire/protocol";
import type { ClientCommand, ServerFrame } from "../../../../lib/wire/protocol";
import { call, connect, setState, state } from "../../state";
import { refreshUsageReports, setSidebarUsage } from "../../state";

// ---------------------------------------------------------------------------
// Minimal /events transport double (mirrors src/state.test.ts's bootstrap):
// connect() registers its SSE handler on a FakeEventSource; tests dispatch
// call_result frames to settle RPCs and capture POSTed /command bodies via a
// stubbed fetch. Bun's test runner has no browser globals, so localStorage
// needs a shim for the setSidebarUsage persistence assertions.
// ---------------------------------------------------------------------------
type SseHandler = (ev: { data: string; lastEventId?: string }) => void;

class FakeEventSource {
	static instances: FakeEventSource[] = [];
	static handlers = new Map<string, SseHandler>();
	onopen: (() => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(public readonly url: string) {
		FakeEventSource.instances.push(this);
	}
	addEventListener(type: string, handler: SseHandler): void {
		FakeEventSource.handlers.set(type, handler);
	}
	close(): void {}
	static dispatch(type: string, data: string, lastEventId?: string): void {
		FakeEventSource.handlers.get(type)?.({ data, lastEventId });
	}
}

const posted: ClientCommand[] = [];

function callResult(id: string, data: unknown, ok = true, error?: string): ServerFrame {
	return { type: "call_result", id, ok, data, ...(error !== undefined ? { error } : {}) };
}

function dispatch(frame: ServerFrame): void {
	FakeEventSource.dispatch(SSE_EVENT_NAME, JSON.stringify(frame));
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function calls(): Extract<ClientCommand, { type: "call" }>[] {
	return posted.filter((c): c is Extract<ClientCommand, { type: "call" }> => c.type === "call");
}

function reportsFixture() {
	return [
		{
			provider: "openai",
			fetchedAt: 1_700_000_000_000,
			notes: [],
			limits: [],
		},
	];
}

let storage: Map<string, string>;

beforeEach(() => {
	posted.length = 0;
	FakeEventSource.instances.length = 0;
	FakeEventSource.handlers.clear();
	storage = new Map();
	// Browser globals the store's transport touches; the Bun test runner has none.
	globalThis.location = { search: "" } as Location;
	globalThis.window = {
		setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
	} as unknown as Window & typeof globalThis;
	globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
	globalThis.localStorage = {
		getItem: (k: string) => storage.get(k) ?? null,
		setItem: (k: string, v: string) => void storage.set(k, v),
		removeItem: (k: string) => void storage.delete(k),
		clear: () => storage.clear(),
		key: (i: number) => [...storage.keys()][i] ?? null,
		get length() {
			return storage.size;
		},
	} as unknown as Storage;
	globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
		if (typeof init?.body === "string") posted.push(JSON.parse(init.body) as ClientCommand);
		return { ok: true, status: 202 } as Response;
	}) as unknown as typeof fetch;
	setState({
		currentSessionId: "",
		connected: false,
		readyAt: undefined,
		subagents: new Map(),
		error: null,
		debugLog: [],
		lastFrameAt: 0,
		reconnectDelay: 0,
		announcement: "",
		chatPinned: true,
		answerUnviewed: false,
		toasts: [],
		items: [],
		streaming: false,
		workingIntent: undefined,
		daemonRoster: [],
		daemonActivity: {},
		registeredProjects: [],
		providerProfiles: [],
		fleetConfigPath: null,
		worktreeDeleteInfo: {},
		pendingSessionPicker: null,
		sessionPickerGate: null,
		workspaceModalProjectId: null,
		deleteWorkspaceTarget: null,
		removeProjectTarget: null,
		modal: null,
		usageReports: null,
		usageLoading: false,
		usageError: null,
	});
});

const originalLocation = globalThis.location;
const originalWindow = globalThis.window;
const originalEventSource = globalThis.EventSource;
const originalFetch = globalThis.fetch;
const originalLocalStorage = globalThis.localStorage;

afterEach(() => {
	globalThis.location = originalLocation;
	globalThis.window = originalWindow;
	globalThis.EventSource = originalEventSource;
	globalThis.fetch = originalFetch;
	globalThis.localStorage = originalLocalStorage;
});

describe("usage store slice", () => {
	test("refreshUsageReports populates usageReports on success", async () => {
		connect();
		const es = FakeEventSource.instances.at(-1);
		expect(es).toBeDefined();
		es!.onopen?.();

		refreshUsageReports();
		expect(state.usageLoading).toBe(true);

		const [cmd] = calls();
		expect(cmd?.method).toBe("fetchUsageReports");
		dispatch(callResult(cmd.id, reportsFixture()));

		await flushMicrotasks();
		expect(state.usageLoading).toBe(false);
		expect(state.usageError).toBeNull();
		expect(state.usageReports).toEqual(reportsFixture());
	});

	test("a second refresh while loading issues no second POST /command", async () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();

		refreshUsageReports();
		refreshUsageReports();
		refreshUsageReports();

		expect(calls().filter((c) => c.method === "fetchUsageReports")).toHaveLength(1);
		expect(calls()).toHaveLength(1);
		expect(state.usageLoading).toBe(true);
	});

	test("a rejection routes to usageError and clears loading", async () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();

		refreshUsageReports();
		const [cmd] = calls();
		dispatch(callResult(cmd.id, null, false, "relay exploded"));

		await flushMicrotasks();
		expect(state.usageLoading).toBe(false);
		// transport's mux rejects with `new Error(frame.error)`; refreshUsageReports
		// mirrors String(err), so the "Error: " prefix is expected.
		expect(state.usageError).toBe("Error: relay exploded");
		expect(state.usageReports).toBeNull();
	});

	test("setSidebarUsage persists localStorage and flips the flag", () => {
		expect(state.sidebarUsage).toBe(false);
		expect(globalThis.localStorage.getItem("omp.sidebarUsage")).toBeNull();

		setSidebarUsage(true);
		expect(state.sidebarUsage).toBe(true);
		expect(globalThis.localStorage.getItem("omp.sidebarUsage")).toBe("true");

		setSidebarUsage(false);
		expect(state.sidebarUsage).toBe(false);
		expect(globalThis.localStorage.getItem("omp.sidebarUsage")).toBe("false");
	});
});
