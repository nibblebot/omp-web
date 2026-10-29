import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Component } from "solid-js";
import { FEATURE_BY_ID, FEATURE_IDS, FEATURES_KEY } from "../../features/manifest";
import type { FeatureId } from "../../features/manifest";
import * as analysisEntry from "../../features/analysis";
import * as gitEntry from "../../features/git";
import type * as Registry from "../../features/registry";
import {
	activateFeatures,
	featureCommand,
	featureModal,
	featureOverlays,
	featureView,
	isFeatureEnabled,
	setFeatureEnabled,
} from "../../features/registry";
import {
	activeFeatureIds,
	type FeaturePreferences,
	featurePreferences,
	markFeaturesActive,
	setFeaturePreference,
} from "../../features/preferences";
import { setState, state } from "../../state";
import { installLocalStorageShim, restoreBrowserGlobals, setBrowserGlobal } from "../web.testkit";

// Module namespaces are live and mock.restore() leaves mocked exports installed.
// Snapshot real exports and explicitly restore them after this suite.
const originalAnalysisEntry = { ...analysisEntry };
const originalGitEntry = { ...gitEntry };
let analysisFetches = 0;
let originalActiveIds: ReadonlySet<FeatureId>;
let originalToasts: typeof state.toasts;
let suiteActiveIds: FeatureId[];
let suiteToasts: typeof state.toasts;

/** Stand-in for the analysis feature's main view. */
const AnalysisView: Component = () => null;

// Reading the entry id happens only when activateFeatures validates a newly
// loaded entry. Count that boundary, not factory evaluation: Bun evaluates
// factories for preloaded modules eagerly when registering their mocks.
const mockedAnalysis = {
	get id() {
		analysisFetches += 1;
		return "analysis";
	},
	view: AnalysisView,
};

beforeAll(() => {
	suiteActiveIds = FEATURE_IDS.filter(isFeatureEnabled);
	suiteToasts = [...state.toasts];
	mock.module("../../features/analysis", () => ({ default: mockedAnalysis }));
	mock.module("../../features/git", () => ({
		default: {
			// Fail inside activateFeatures' load/validation catch, rather than
			// throwing eagerly while Bun registers an already-loaded mock.
			get id() {
				throw new Error("chunk load failed");
			},
		},
	}));
});

afterAll(async () => {
	// The registry may retain the loaded entry object. Restore its slots too,
	// so future activations cannot expose this suite's stand-in component.
	Object.defineProperties(
		mockedAnalysis,
		Object.getOwnPropertyDescriptors(originalAnalysisEntry.default),
	);
	mock.module("../../features/analysis", () => originalAnalysisEntry);
	mock.module("../../features/git", () => originalGitEntry);
	try {
		await activateFeatures(suiteActiveIds);
	} finally {
		setState("toasts", suiteToasts);
	}
});

beforeEach(() => {
	originalActiveIds = activeFeatureIds();
	originalToasts = [...state.toasts];
	markFeaturesActive([]);
	setState("toasts", []);
	// pushToast schedules its auto-dismiss on window, which bun does not have;
	// the stub keeps the failure-toast path from throwing.
	setBrowserGlobal("window", { setTimeout: () => 0 } as unknown as Window & typeof globalThis);
});

afterEach(() => {
	markFeaturesActive(originalActiveIds);
	setState("toasts", originalToasts);
	restoreBrowserGlobals();
});

describe("feature registry activation", () => {
	test("a disabled feature is never fetched and exposes no slots", async () => {
		await activateFeatures([]);
		expect(isFeatureEnabled("analysis")).toBe(false);
		expect(featureView("analysis")).toBeUndefined();
		expect(featureModal("plan-review")).toBeUndefined();
		expect(featureCommand("plan")).toBeUndefined();
		expect(featureOverlays()).toEqual([]);
		expect(analysisFetches).toBe(0);
	});

	test("activating a feature loads its entry once and exposes its slots", async () => {
		const before = analysisFetches;
		await activateFeatures(["analysis"]);
		expect(analysisFetches).toBe(before + 1);
		expect(isFeatureEnabled("analysis")).toBe(true);
		expect(featureView("analysis")).toBe(AnalysisView);

		// Modules load once per page: re-activating must not re-fetch.
		await activateFeatures(["analysis"]);
		expect(analysisFetches).toBe(before + 1);
	});

	test("a feature whose loader rejects stays off and surfaces a toast", async () => {
		// Exercise loading with a fresh page cache even when a sibling suite
		// already activated git. Static imports share the page-lifetime cache.
		const registrySpecifier = `../../features/registry.ts?fresh=${crypto.randomUUID()}`;
		const isolatedRegistry: typeof Registry = await import(registrySpecifier);
		const { activateFeatures, featureCommand, featureModal, featureOverlays, isFeatureEnabled } =
			isolatedRegistry;
		await activateFeatures(["analysis"]);
		// The failure is logged for the console (captured: bun prints it)...
		const logged: string[] = [];
		const originalError = console.error;
		console.error = (msg?: unknown) => {
			logged.push(String(msg));
		};
		try {
			await activateFeatures(["git"]);
		} finally {
			console.error = originalError;
		}
		expect(logged).toHaveLength(1);
		expect(logged[0]).toContain("git");
		// ...the failed feature is off and its slots stay empty...
		expect(isFeatureEnabled("git")).toBe(false);
		expect(featureCommand("git")).toBeUndefined();
		expect(featureModal("annotations")).toBeUndefined();
		expect(featureOverlays()).toEqual([]);
		// ...and it replaced the active set rather than joining it.
		expect(isFeatureEnabled("analysis")).toBe(false);
		// The failure is surfaced with the cause, not swallowed.
		const toast = state.toasts.at(-1);
		expect(toast?.text).toContain(FEATURE_BY_ID.git.label);
		expect(toast?.text).toContain("could not load");
		expect(toast?.text).toContain("chunk load failed");
	});
});

describe("live feature toggles", () => {
	let originalPrefs: FeaturePreferences;
	let originalModal: typeof state.modal;
	let originalDock: typeof state.dock;
	let originalView: typeof state.view;

	/** Make the stored choices exactly `ids`: every other feature off. */
	function setPreferredOnly(ids: readonly FeatureId[]): void {
		for (const id of FEATURE_IDS) setFeaturePreference(id, ids.includes(id));
	}

	beforeEach(() => {
		originalPrefs = { ...featurePreferences() };
		originalModal = state.modal;
		originalDock = state.dock;
		originalView = state.view;
	});

	afterEach(() => {
		for (const id of FEATURE_IDS) setFeaturePreference(id, originalPrefs[id]);
		setState({ modal: originalModal, dock: originalDock, view: originalView });
	});

	test("a superseded activation resolves null and never overwrites the newer set", async () => {
		const first = activateFeatures(["analysis"]);
		const second = activateFeatures([]);
		expect(await first).toBeNull();
		expect(await second).toEqual(new Set());
		expect(isFeatureEnabled("analysis")).toBe(false);
	});

	test("turning a feature on and off changes its slots, and re-enabling does not re-fetch", async () => {
		setPreferredOnly([]);
		await setFeatureEnabled("debug", true);
		expect(isFeatureEnabled("debug")).toBe(true);
		const modal = featureModal("debug");
		expect(modal).toBeDefined();
		await setFeatureEnabled("debug", false);
		expect(isFeatureEnabled("debug")).toBe(false);
		expect(featureModal("debug")).toBeUndefined();
		await setFeatureEnabled("debug", true);
		expect(isFeatureEnabled("debug")).toBe(true);
		expect(featureModal("debug")).toBe(modal);
	});

	test("an in-development feature cannot be turned on and nothing is persisted or loaded", async () => {
		installLocalStorageShim();
		setPreferredOnly([]);
		localStorage.removeItem(FEATURES_KEY);
		const before = analysisFetches;
		await setFeatureEnabled("analysis", true);
		expect(isFeatureEnabled("analysis")).toBe(false);
		expect(featurePreferences().analysis).toBe(false);
		expect(localStorage.getItem(FEATURES_KEY)).toBeNull();
		expect(analysisFetches).toBe(before);
	});

	test("turning a feature off closes the modal it owned and keeps an unrelated one", async () => {
		setPreferredOnly(["debug", "plugins"]);
		await activateFeatures(["debug", "plugins"]);
		setState("modal", "debug");
		await setFeatureEnabled("debug", false);
		expect(state.modal).toBeNull();

		setState("modal", "sign-in");
		await setFeatureEnabled("plugins", false);
		expect(state.modal).toBe("sign-in");
	});

	test("a toggle that leaves Analysis out of the active set returns the view to chat", async () => {
		setPreferredOnly(["debug"]);
		await activateFeatures(["analysis", "debug"]);
		setState("view", "analysis");
		await setFeatureEnabled("debug", false);
		expect(state.view).toBe("chat");
	});

	test("turning a feature off closes a dock panel it owned", async () => {
		setPreferredOnly([]);
		setState("dock", { kind: "review" });
		await setFeatureEnabled("git", false);
		expect(state.dock).toBeNull();
	});
});
