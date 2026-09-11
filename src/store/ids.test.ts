/** Regression: `crypto.randomUUID` is secure-context-only, so plain-HTTP
 * origins must not throw at module scope. */

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
	if (originalRandomUUID !== undefined) {
		Object.defineProperty(crypto, "randomUUID", originalRandomUUID);
		return;
	}
	// `randomUUID` lives on the prototype here; drop the own override instead
	// of shadowing it with `undefined`, or every later reader loses it.
	Reflect.deleteProperty(crypto, "randomUUID");
});

/** Shape, version nibble, and RFC 4122 variant 10xx of a v4 UUID. */
function expectV4Uuid(id: string): void {
	expect(id).toMatch(UUID_RE);
	expect(id[14]).toBe("4");
	expect("89ab").toContain(id[19]);
}

describe("randomId", () => {
	test("returns a v4 UUID on a secure origin", () => {
		expectV4Uuid(randomId());
	});

	test("falls back to a v4 UUID when crypto.randomUUID is unavailable", () => {
		hideRandomUUID();
		expectV4Uuid(randomId());
	});
});
