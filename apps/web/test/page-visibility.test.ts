/**
 * Background work follows the tab: an interval runs while the page is visible, stops while it is hidden
 * (no tick at all, so a hidden tab asks and writes nothing), and on return ticks once at once and resumes.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { createRoot } from "solid-js";
import { createVisibleInterval, isPageVisible } from "../page-visibility";

const originalDocument = Reflect.get(globalThis, "document");
let visibility: "visible" | "hidden" = "visible";
let listeners = new Set<() => void>();

/** Bun's test env has no DOM: a stand-in with the members the helper reads. */
const fakeDocument = {
	get visibilityState() {
		return visibility;
	},
	addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
	removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
};
const setVisibility = (next: "visible" | "hidden") => {
	visibility = next;
	for (const listener of listeners) listener();
};

beforeEach(() => {
	vi.useFakeTimers();
	visibility = "visible";
	listeners = new Set();
	Reflect.set(globalThis, "document", fakeDocument);
});
afterEach(() => {
	vi.useRealTimers();
	Reflect.set(globalThis, "document", originalDocument);
});
afterAll(() => {
	Reflect.set(globalThis, "document", originalDocument);
});

describe("isPageVisible", () => {
	test("follows the document, and is true where there is none", () => {
		expect(isPageVisible()).toBe(true);
		visibility = "hidden";
		expect(isPageVisible()).toBe(false);
		Reflect.deleteProperty(globalThis, "document");
		expect(isPageVisible()).toBe(true);
	});
});

describe("createVisibleInterval", () => {
	test("ticks on the period while visible", () => {
		let ticks = 0;
		const dispose = createRoot((d) => {
			createVisibleInterval(() => ticks++, 1000);
			return d;
		});
		vi.advanceTimersByTime(3000);
		expect(ticks).toBe(3);
		dispose();
	});

	test("starts no timer in a hidden page, and ticks once when it becomes visible", () => {
		visibility = "hidden";
		let ticks = 0;
		const dispose = createRoot((d) => {
			createVisibleInterval(() => ticks++, 1000);
			return d;
		});
		vi.advanceTimersByTime(60_000);
		expect(ticks).toBe(0);
		setVisibility("visible");
		expect(ticks).toBe(1);
		vi.advanceTimersByTime(2000);
		expect(ticks).toBe(3);
		dispose();
	});

	test("stops ticking while hidden and resumes with a fresh period", () => {
		let ticks = 0;
		const dispose = createRoot((d) => {
			createVisibleInterval(() => ticks++, 1000);
			return d;
		});
		vi.advanceTimersByTime(1000);
		expect(ticks).toBe(1);
		setVisibility("hidden");
		vi.advanceTimersByTime(60_000);
		expect(ticks).toBe(1);
		setVisibility("visible");
		expect(ticks).toBe(2);
		vi.advanceTimersByTime(999);
		expect(ticks).toBe(2);
		vi.advanceTimersByTime(1);
		expect(ticks).toBe(3);
		dispose();
	});

	test("disposing the owner stops the timer and drops the listener", () => {
		let ticks = 0;
		const dispose = createRoot((d) => {
			createVisibleInterval(() => ticks++, 1000);
			return d;
		});
		expect(listeners.size).toBe(1);
		dispose();
		expect(listeners.size).toBe(0);
		vi.advanceTimersByTime(5000);
		expect(ticks).toBe(0);
	});
});
