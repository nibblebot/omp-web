import { describe, expect, test } from "bun:test";
import { isAgentsShortcut } from "../../store/dock";

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
