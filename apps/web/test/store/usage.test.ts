import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { connect, setState, state } from "../../state";
import { refreshUsageReports, setSidebarUsage } from "../../state";
import {
	installLocalStorageShim,
	installTransportStubs,
	restoreBrowserGlobals,
	setBrowserGlobal,
} from "../web.testkit";

type RecordedFetch = { url: string; method: string };

/** Swap globalThis.fetch for a JSON responder; records every request URL and method. */
function stubFetch(respond: (url: string) => { status: number; body: unknown }): RecordedFetch[] {
	const requests: RecordedFetch[] = [];
	setBrowserGlobal("fetch", (async (input: unknown, init?: RequestInit) => {
		const url = String(input);
		requests.push({ url, method: init?.method ?? "GET" });
		const { status, body } = respond(url);
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => body,
			text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
		} as unknown as Response;
	}) as unknown as typeof fetch);
	return requests;
}

/** Drain the fetch -> json -> finally chain (each hop is one microtask). */
async function settle(): Promise<void> {
	for (let i = 0; i < 32; i++) await Promise.resolve();
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
		usageRefreshedAt: null,
		authStatus: "disabled",
	});
});

// Browser doubles are process-global (see web.testkit.ts); restore the originals
// after each test.
afterEach(restoreBrowserGlobals);

describe("usage store slice", () => {
	test("before the browser socket opens, refreshUsageReports GETs /ctl/usage and fills the mirror", async () => {
		connect(); // the socket is dialed but onopen never fires: the page-load window
		const requests = stubFetch(() => ({ status: 200, body: reportsFixture() }));

		const before = Date.now();
		refreshUsageReports();
		expect(state.usageLoading).toBe(true);
		expect(state.usageRefreshedAt).toBeNull();
		await settle();

		// Exactly one GET; nothing was sent in band.
		expect(requests).toEqual([{ url: "/ctl/usage", method: "GET" }]);
		expect(state.connected).toBe(false);
		expect(state.usageLoading).toBe(false);
		expect(state.usageError).toBeNull();
		expect(state.usageReports).toEqual(reportsFixture());
		// The settle time anchors the sidebar's auto-refresh countdown.
		expect(state.usageRefreshedAt).toBeGreaterThanOrEqual(before);
	});

	test("a second refresh while loading issues no second GET", async () => {
		const requests = stubFetch(() => ({ status: 200, body: reportsFixture() }));

		refreshUsageReports();
		refreshUsageReports();
		refreshUsageReports();
		expect(state.usageLoading).toBe(true);
		await settle();
		expect(requests.filter((r) => r.url === "/ctl/usage")).toHaveLength(1);

		// Once settled, a user-action refresh fetches again.
		refreshUsageReports();
		await settle();
		expect(requests).toHaveLength(2);
	});

	test("a non-ok response routes its {error} message to usageError and clears loading", async () => {
		const requests = stubFetch(() => ({
			status: 503,
			body: { error: "Usage endpoint returned 503" },
		}));

		refreshUsageReports();
		await settle();

		expect(requests).toEqual([{ url: "/ctl/usage", method: "GET" }]);
		expect(state.usageLoading).toBe(false);
		expect(state.usageError).toBe("Usage endpoint returned 503");
		expect(state.usageReports).toBeNull();
		// A failure also restarts the countdown, so a broken endpoint is retried on schedule, not hammered.
		expect(state.usageRefreshedAt).not.toBeNull();
	});

	test("a successful refresh clears a previous usageError; a null body means []", async () => {
		setState("usageError", "Usage endpoint returned 503");
		stubFetch(() => ({ status: 200, body: null }));

		refreshUsageReports();
		await settle();

		expect(state.usageError).toBeNull();
		expect(state.usageReports).toEqual([]);
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
