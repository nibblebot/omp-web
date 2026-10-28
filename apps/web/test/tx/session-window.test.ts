/**
 * Windowing of the Analysis session list (tx/util/session-window.ts): groups of
 * fixed-pitch rows stacked under sticky heads mount only the rows near the viewport.
 */
import { describe, expect, test } from "bun:test";
import { groupSpans } from "../../tx/util/session-window";

const PITCH = 100;
const HEAD = 30;

describe("groupSpans", () => {
	test("stacks groups by head plus rows and mounts nothing in a group far below the viewport", () => {
		const spans = groupSpans([20, 20, 20], 0, 300, PITCH, HEAD);
		expect(spans.map((s) => s.top)).toEqual([0, 2030, 4060]);
		expect(spans[0]!.end).toBeGreaterThan(0);
		expect(spans[1]).toMatchObject({ start: 0, end: 0 });
		expect(spans[2]).toMatchObject({ start: 0, end: 0 });
	});

	test("follows the scroll position inside a long group", () => {
		const [span] = groupSpans([2000], 100_030, 300, PITCH, HEAD);
		// Row 1000 is the first fully past the head at that offset; overscan sits around it.
		expect(span!.start).toBeGreaterThan(980);
		expect(span!.end).toBeLessThan(1020);
		expect(span!.end - span!.start).toBeLessThan(30);
	});

	test("the group above the viewport unmounts its rows once scrolled well past", () => {
		const spans = groupSpans([5, 50], 5000, 300, PITCH, HEAD);
		expect(spans[0]).toMatchObject({ start: 0, end: 0 });
		expect(spans[1]!.end).toBeGreaterThan(spans[1]!.start);
	});

	test("a group straddling the viewport top mounts its trailing rows", () => {
		const [span] = groupSpans([10], 800, 300, PITCH, HEAD);
		expect(span!.end).toBe(10);
		expect(span!.start).toBeLessThan(10);
	});

	test("no groups, no spans; an empty group mounts nothing", () => {
		expect(groupSpans([], 0, 300, PITCH, HEAD)).toEqual([]);
		expect(groupSpans([0], 0, 300, PITCH, HEAD)[0]).toMatchObject({ start: 0, end: 0 });
	});
});
