import { describe, expect, test } from "bun:test";
import { sameToken } from "../../prompt/autocomplete";
import {
	enterKeyHint,
	enterSendsMessage,
	isImeKey,
	resolveEnterAction,
} from "../../prompt/key-input";
import { keyboardShrank } from "../../prefs/viewport";
import { downscaleFactor } from "../../prompt/paste";
import { ENTER_KEY_CHOICES } from "../../prefs/display";

const plain = { shiftKey: false, ctrlKey: false, metaKey: false };

describe("enterSendsMessage (Enter key preference x pointer type)", () => {
	test("auto sends with a fine pointer and inserts a newline on a coarse one", () => {
		expect(enterSendsMessage("auto", false)).toBe(true);
		expect(enterSendsMessage("auto", true)).toBe(false);
	});

	test("an explicit choice ignores the pointer", () => {
		for (const coarse of [false, true]) {
			expect(enterSendsMessage("send", coarse)).toBe(true);
			expect(enterSendsMessage("newline", coarse)).toBe(false);
		}
	});

	test("every choice resolves for both pointer types", () => {
		for (const pref of ENTER_KEY_CHOICES) {
			expect(typeof enterSendsMessage(pref, true)).toBe("boolean");
			expect(typeof enterSendsMessage(pref, false)).toBe("boolean");
		}
	});
});

describe("resolveEnterAction", () => {
	test("a plain Enter follows the preference", () => {
		expect(resolveEnterAction(plain, true)).toBe("send");
		expect(resolveEnterAction(plain, false)).toBe("newline");
	});

	test("Shift+Enter is a newline whatever the preference", () => {
		expect(resolveEnterAction({ ...plain, shiftKey: true }, true)).toBe("newline");
		expect(resolveEnterAction({ ...plain, shiftKey: true }, false)).toBe("newline");
	});

	test("Ctrl/Cmd+Enter still submits (as a follow-up) when Enter inserts a newline", () => {
		expect(resolveEnterAction({ ...plain, ctrlKey: true }, false)).toBe("followup");
		expect(resolveEnterAction({ ...plain, metaKey: true }, false)).toBe("followup");
		expect(resolveEnterAction({ ...plain, ctrlKey: true }, true)).toBe("followup");
	});

	test("the soft keyboard's Enter key is labelled for what it does", () => {
		expect(enterKeyHint(true)).toBe("send");
		expect(enterKeyHint(false)).toBe("enter");
	});
});

describe("isImeKey", () => {
	test("a composing keydown belongs to the IME", () => {
		expect(isImeKey({ isComposing: true, keyCode: 13 })).toBe(true);
	});

	test("Android keyboards report keyCode 229 without isComposing", () => {
		expect(isImeKey({ isComposing: false, keyCode: 229 })).toBe(true);
	});

	test("an ordinary key is not", () => {
		expect(isImeKey({ isComposing: false, keyCode: 13 })).toBe(false);
	});
});

describe("sameToken", () => {
	const token = { mode: "slash", query: "mo", start: 0, end: 3 } as const;

	test("a repeated caret read of the same span is not a change", () => {
		expect(sameToken(token, { ...token })).toBe(true);
		expect(sameToken(null, null)).toBe(true);
	});

	test("a moved span, another query or a cleared token is", () => {
		expect(sameToken(token, { ...token, end: 4 })).toBe(false);
		expect(sameToken(token, { ...token, query: "mod" })).toBe(false);
		expect(sameToken(token, null)).toBe(false);
		expect(sameToken(null, token)).toBe(false);
	});
});

describe("keyboardShrank", () => {
	test("a keyboard-sized shrink counts; browser chrome sliding away does not", () => {
		expect(keyboardShrank(800, 500)).toBe(true);
		expect(keyboardShrank(800, 740)).toBe(false);
		expect(keyboardShrank(800, 800)).toBe(false);
	});
});

describe("downscaleFactor", () => {
	test("an image under the limit is left alone", () => {
		expect(downscaleFactor(5_000_000, 10_000_000)).toBe(1);
	});

	test("an oversize image scales each side by the square root of the size ratio, with headroom", () => {
		const scale = downscaleFactor(20_000_000, 10_000_000);
		expect(scale).toBeLessThan(Math.sqrt(0.5));
		expect(scale).toBeGreaterThan(0.5);
	});
});
