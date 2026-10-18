import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ClientCommand } from "#lib/wire/protocol";
import { connect, setState, state } from "../../state";
import { refreshUsageReports, setSidebarUsage } from "../../state";
import {
	FakeEventSource,
	callResult,
	dispatch,
	flushMicrotasks,
	installLocalStorageShim,
	installTransportStubs,
	posted,
	restoreBrowserGlobals,
} from "../web.testkit";

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

beforeEach(() => {
	installTransportStubs();
	installLocalStorageShim();
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
		newWorkspaceProjectId: null,
		highlightProjectId: null,
		deleteWorkspaceTarget: null,
		removeProjectTarget: null,
		lightboxImage: null,
		daemonDetailsId: null,
		modal: null,
		usageReports: null,
		usageLoading: false,
		usageError: null,
	});
});

// Browser doubles are process-global (see web.testkit.ts); restore the originals
// after each test.
afterEach(restoreBrowserGlobals);

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

	test("sidebarUsage defaults on and respects a saved false", () => {
		// Default-on: the FLEET-17 finding is that the panel never showed because it defaulted off.
		expect(globalThis.localStorage.getItem("omp.sidebarUsage")).toBeNull();
		expect(state.sidebarUsage).toBe(true);
		setSidebarUsage(false);
		expect(globalThis.localStorage.getItem("omp.sidebarUsage")).toBe("false");
		expect(state.sidebarUsage).toBe(false);
	});

	test("setSidebarUsage persists localStorage and flips the flag", () => {
		setSidebarUsage(true);
		expect(state.sidebarUsage).toBe(true);
		expect(globalThis.localStorage.getItem("omp.sidebarUsage")).toBe("true");

		setSidebarUsage(false);
		expect(state.sidebarUsage).toBe(false);
		expect(globalThis.localStorage.getItem("omp.sidebarUsage")).toBe("false");
	});
});
