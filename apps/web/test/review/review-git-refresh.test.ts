/**
 * Regression test for ReviewPanel's git refresh wiring (g90p). State frames replace
 * the capabilities object, so a bare dependency on the git capability re-fires on
 * every frame and loops gitStatus calls. The panel reads the capability through
 * `createMemo`, which only notifies on a changed value. The component itself cannot
 * run under bun (bun resolves solid-js to its SSR build), so this test asserts the
 * same wiring against the reactive client build, with a bare-read contrast.
 */
import { describe, expect, test } from "bun:test";
// Reactive client build; see apps/web/test/tx/transcript-view.test.ts.
import { createMemo, createRoot, createSignal } from "solid-js/dist/solid.js";

type Capabilities = { git: boolean };

describe("ReviewPanel git refresh wiring", () => {
	test("memoized availability refreshes once per distinct value, not per state frame", () => {
		const { setCapabilities, refreshes } = createRoot(() => {
			const [capabilities, setCapabilities] = createSignal<Capabilities>({ git: false });
			const gitAvailable = createMemo(() => capabilities().git === true);
			let refreshes = 0;
			createMemo(() => {
				if (gitAvailable()) refreshes += 1;
			});
			return { setCapabilities, refreshes: () => refreshes };
		});

		// Three frames, each a fresh object with the same capability.
		setCapabilities({ git: true });
		setCapabilities({ git: true });
		setCapabilities({ git: true });
		expect(refreshes()).toBe(1);

		// A real transition back and forth is one refresh per rising edge.
		setCapabilities({ git: false });
		setCapabilities({ git: true });
		expect(refreshes()).toBe(2);
	});

	test("contrast: a bare read of the capability re-fires on every state frame", () => {
		const { setCapabilities, refreshes } = createRoot(() => {
			const [capabilities, setCapabilities] = createSignal<Capabilities>({ git: false });
			let refreshes = 0;
			createMemo(() => {
				if (capabilities().git === true) refreshes += 1;
			});
			return { setCapabilities, refreshes: () => refreshes };
		});

		setCapabilities({ git: true });
		setCapabilities({ git: true });
		setCapabilities({ git: true });
		expect(refreshes()).toBe(3);
	});
});
