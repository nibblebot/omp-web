/**
 * Regression coverage for the non-secure-origin id helper.
 *
 * The bug: `crypto.randomUUID` is restricted to secure contexts, so an
 * unguarded call on a plain-HTTP non-loopback origin (for example
 * `http://192.168.5.15:4713`) throws `TypeError: crypto.randomUUID is not a
 * function`. At module scope that aborted the whole bundle and rendered a
 * blank page.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { randomId } from "./ids";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The live descriptor, restored after every case. */
const originalRandomUUID = Object.getOwnPropertyDescriptor(crypto, "randomUUID");

/** Present `crypto.randomUUID` as an insecure origin does: defined but undefined. */
function hideRandomUUID(): void {
	Object.defineProperty(crypto, "randomUUID", {
		value: undefined,
		configurable: true,
		writable: true,
	});
}

afterEach(() => {
	if (originalRandomUUID !== undefined)
		Object.defineProperty(crypto, "randomUUID", originalRandomUUID);
	else hideRandomUUID();
});

describe("randomId", () => {
	test("uses crypto.randomUUID when the origin is a secure context", () => {
		Object.defineProperty(crypto, "randomUUID", {
			value: () => "00000000-1111-4222-8333-444444444444",
			configurable: true,
			writable: true,
		});
		expect(randomId()).toBe("00000000-1111-4222-8333-444444444444");
	});

	test("falls back to a v4 UUID when crypto.randomUUID is unavailable", () => {
		hideRandomUUID();
		const id = randomId();
		expect(id).toMatch(UUID_RE);
		// Version 4 and variant 10xx, so the value is a well-formed v4 UUID and
		// not merely random hex that happens to match the shape.
		expect(id[14]).toBe("4");
		expect("89ab").toContain(id[19]);
	});

	test("successive ids are distinct", () => {
		hideRandomUUID();
		const ids = Array.from({ length: 64 }, () => randomId());
		const firstIndexOf = (id: string): number => ids.indexOf(id);
		const unique = ids.filter((id, index) => firstIndexOf(id) === index);
		expect(unique.length).toBe(ids.length);
	});
});
