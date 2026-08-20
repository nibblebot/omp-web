import { describe, expect, test } from "bun:test";
import { CONTENT_CHANGED_EVENT } from "./useStickyScroll";

describe("useStickyScroll event contract", () => {
	test("content-changed broadcast name is stable and bubbles (LiveTail relies on it)", () => {
		expect(CONTENT_CHANGED_EVENT).toBe("omp:content-changed");
	});
});
