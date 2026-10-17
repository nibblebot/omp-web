import { describe, expect, test } from "bun:test";
import { registerFocusReturn, resolveFocusReturn, type FocusNode } from "../components/ui/focus";

// Fake DOM nodes: the resolver only reads isConnected, parentElement and focus().
function node(name: string, parent: FakeNode | null = null, connected = true): FakeNode {
	return {
		name,
		isConnected: connected,
		parentElement: parent,
		focus() {
			this.focused = true;
		},
		focused: false,
	} as FakeNode;
}

type FakeNode = FocusNode & { name: string; focused: boolean };

describe("resolveFocusReturn", () => {
	test("returns the origin when it is still connected", () => {
		const origin = node("trigger");
		expect(resolveFocusReturn(origin, () => node("fallback"))).toBe(origin);
	});

	test("walks detached ancestors to the registered trigger", () => {
		const trigger = node("trigger");
		const container = node("menu", null, false);
		const row = node("row", container, false);
		const origin = node("menu-item", row, false);
		registerFocusReturn(container, () => trigger);
		expect(resolveFocusReturn(origin, () => null)).toBe(trigger);
	});

	test("ignores a registered trigger that is itself detached", () => {
		const gone = node("trigger", null, false);
		const container = node("menu", null, false);
		registerFocusReturn(container, () => gone);
		const fallback = node("composer");
		expect(resolveFocusReturn(node("item", container, false), () => fallback)).toBe(fallback);
	});

	test("uses the page fallback when the origin is missing", () => {
		const composer = node("composer");
		expect(resolveFocusReturn(null, () => composer)).toBe(composer);
	});

	test("returns null when neither the origin nor the fallback is connected", () => {
		const composer = node("composer", null, false);
		expect(resolveFocusReturn(null, () => composer)).toBeNull();
		expect(resolveFocusReturn(node("gone", null, false), () => null)).toBeNull();
	});
});
