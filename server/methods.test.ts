/**
 * Unit tests for the SDK-drift-sensitive rows of the web methods table
 * (server/methods.ts). These rows are the ones 18.x rewrote: computer use is
 * an eval prelude gated by the session-scoped `computer.enabled` setting, and
 * the inspect_image tool is gone. A real daemon covers the reachable wire
 * behavior (server/omp-session.test.ts); the branches that depend on session
 * internals (no active prelude, a failing prompt rebuild) are driven here with
 * a stub session so the parity logic is asserted directly.
 */

import { describe, expect, test } from "bun:test";
import { createWebMethods } from "./methods";
import type { SessionEntry } from "./session-entry";

interface StubSession {
	settings: { get: (key: string) => boolean; override: (key: string, value: boolean) => void };
	getEvalPreludes: () => ReadonlyArray<{ name: string }>;
	refreshBaseSystemPrompt: () => Promise<void>;
}

/** A session stub recording the override writes and prompt rebuilds it saw. */
function stubEntry(opts: { preludes?: ReadonlyArray<{ name: string }>; refreshError?: Error }): {
	entry: SessionEntry;
	overrides: Array<boolean>;
	refreshes: () => number;
} {
	let value = false;
	let refreshes = 0;
	const session: StubSession = {
		settings: {
			get: () => value,
			override: (_key, next) => {
				value = next;
			},
		},
		getEvalPreludes: () => opts.preludes ?? [],
		refreshBaseSystemPrompt: async () => {
			refreshes++;
			if (opts.refreshError) throw opts.refreshError;
		},
	};
	return {
		entry: { session } as unknown as SessionEntry,
		overrides: [],
		refreshes: () => refreshes,
	};
}

function methodsTable() {
	return createWebMethods({
		settings: {} as never,
		authStorage: {} as never,
		collab: {} as never,
		broker: {} as never,
		// Clone-workspace deps (P8.9 wake): unused by these rows, so inert doubles.
		materializeSession: async () => ({ alreadyPresent: true as const }),
		sessionsDir: "/tmp/fleet-test-sessions",
		hasCallbackPair: () => false,
	}).methods;
}

describe("computer/inspect_image rows after the 18.x drift", () => {
	test("enabling without an active computer prelude reverts the override and refuses", async () => {
		// Parity with the SDK's own /computer toggle (applyComputerUseToggle):
		// the prelude only exists while the eval tool is active, so a session
		// without one must not be left believing computer use is on.
		const { entry, refreshes } = stubEntry({ preludes: [] });
		const methods = methodsTable();
		await expect(methods.setComputerToolEnabled(entry, [true])).rejects.toThrow(
			"unavailable in this session",
		);
		expect(entry.session.settings.get("computer.enabled")).toBe(false);
		expect(refreshes()).toBe(0);
	});

	test("enabling with an active prelude keeps the override and rebuilds the prompt", async () => {
		const { entry, refreshes } = stubEntry({ preludes: [{ name: "computer" }] });
		const methods = methodsTable();
		await methods.setComputerToolEnabled(entry, [true]);
		expect(entry.session.settings.get("computer.enabled")).toBe(true);
		expect(refreshes()).toBe(1);
	});

	test("disabling needs no prelude and still rebuilds the prompt", async () => {
		const { entry, refreshes } = stubEntry({ preludes: [] });
		const methods = methodsTable();
		await methods.setComputerToolEnabled(entry, [false]);
		expect(entry.session.settings.get("computer.enabled")).toBe(false);
		expect(refreshes()).toBe(1);
	});

	test("a failed prompt rebuild rolls the override back", async () => {
		const { entry } = stubEntry({
			preludes: [{ name: "computer" }],
			refreshError: new Error("prompt rebuild exploded"),
		});
		const methods = methodsTable();
		await expect(methods.setComputerToolEnabled(entry, [true])).rejects.toThrow(
			"prompt rebuild exploded",
		);
		expect(entry.session.settings.get("computer.enabled")).toBe(false);
	});

	test("setInspectImageMode is a loud tombstone, never a silent success", () => {
		const { entry, refreshes } = stubEntry({ preludes: [{ name: "computer" }] });
		const methods = methodsTable();
		// The row throws synchronously; the dispatch core turns that into an
		// ok:false call_result (asserted over the wire in omp-session.test.ts).
		expect(() => methods.setInspectImageMode(entry, ["auto"])).toThrow("inspect_image");
		expect(refreshes()).toBe(0);
	});
});
