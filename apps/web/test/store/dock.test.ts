import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { backFromDock, isAgentsShortcut } from "../../store/dock";
import { setState, state } from "../../state";

function key(init: { key: string; altKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }) {
	return { altKey: false, ctrlKey: false, shiftKey: false, ...init };
}

describe("isAgentsShortcut (Alt+A)", () => {
	test("matches Alt+A from anywhere, including a focused composer textarea", () => {
		expect(isAgentsShortcut(key({ key: "a", altKey: true }))).toBe(true);
		expect(isAgentsShortcut(key({ key: "A", altKey: true }))).toBe(true);
	});

	test("rejects the bare key and chords with other modifiers", () => {
		expect(isAgentsShortcut(key({ key: "a" }))).toBe(false);
		expect(isAgentsShortcut(key({ key: "a", altKey: true, ctrlKey: true }))).toBe(false);
		expect(isAgentsShortcut(key({ key: "a", altKey: true, shiftKey: true }))).toBe(false);
	});

	test("rejects Option+A on mac, which types a different character", () => {
		expect(isAgentsShortcut(key({ key: "å", altKey: true }))).toBe(false);
	});
});

describe("backFromDock (Back and Esc on the dock)", () => {
	let original: typeof state.dock;
	beforeEach(() => {
		original = state.dock;
	});
	afterEach(() => {
		setState("dock", original);
	});

	test("an agent pane steps back to the agents list", () => {
		setState("dock", { kind: "agent", id: "a1" });
		backFromDock();
		expect(state.dock?.id).toBeUndefined();
		expect(state.dock?.kind).toBe("agents");
	});

	test("the agents list and other panels close", () => {
		setState("dock", { kind: "agents" });
		backFromDock();
		expect(state.dock).toBeNull();
		setState("dock", { kind: "tree" });
		backFromDock();
		expect(state.dock).toBeNull();
	});
});
