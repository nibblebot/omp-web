import { describe, expect, test } from "bun:test";
import { moveRovingFocus, rovingTarget, setRovingTabStop } from "../components/ui/roving";

describe("rovingTarget", () => {
	test("vertical arrows step and clamp at the ends", () => {
		expect(rovingTarget("ArrowDown", "vertical", 0, 3)).toBe(1);
		expect(rovingTarget("ArrowUp", "vertical", 0, 3)).toBe(0);
		expect(rovingTarget("ArrowDown", "vertical", 2, 3)).toBe(2);
	});

	test("wrap cycles past either end", () => {
		expect(rovingTarget("ArrowDown", "vertical", 2, 3, true)).toBe(0);
		expect(rovingTarget("ArrowUp", "vertical", 0, 3, true)).toBe(2);
	});

	test("horizontal axis uses left and right, not up and down", () => {
		expect(rovingTarget("ArrowRight", "horizontal", 0, 3)).toBe(1);
		expect(rovingTarget("ArrowLeft", "horizontal", 1, 3)).toBe(0);
		expect(rovingTarget("ArrowDown", "horizontal", 0, 3)).toBeNull();
	});

	test("Home and End jump to the ends", () => {
		expect(rovingTarget("Home", "vertical", 2, 5)).toBe(0);
		expect(rovingTarget("End", "vertical", 0, 5)).toBe(4);
	});

	test("unhandled keys and empty lists return null", () => {
		expect(rovingTarget("Enter", "vertical", 0, 3)).toBeNull();
		expect(rovingTarget("ArrowDown", "vertical", 0, 0)).toBeNull();
	});

	test("a current index of -1 starts from the first item going forward", () => {
		expect(rovingTarget("ArrowDown", "vertical", -1, 3)).toBe(0);
	});
});

type FakeItem = HTMLElement & { focused: boolean };

function items(count: number): FakeItem[] {
	return Array.from({ length: count }, () => {
		const el = { tabIndex: -1, focused: false } as FakeItem;
		el.focus = () => {
			el.focused = true;
		};
		return el;
	});
}

function key(name: string) {
	return {
		key: name,
		prevented: false,
		preventDefault() {
			this.prevented = true;
		},
	};
}

describe("setRovingTabStop", () => {
	test("exactly one item is in the tab order", () => {
		const list = items(3);
		setRovingTabStop(list, 1);
		expect(list.map((el) => el.tabIndex)).toEqual([-1, 0, -1]);
	});
});

describe("moveRovingFocus", () => {
	test("moves focus, updates the tab stop, and prevents default", () => {
		const list = items(3);
		const e = key("ArrowDown");
		const next = moveRovingFocus(e as unknown as KeyboardEvent, list, 0, "vertical");
		expect(next).toBe(1);
		expect(list[1].focused).toBe(true);
		expect(list.map((el) => el.tabIndex)).toEqual([-1, 0, -1]);
		expect(e.prevented).toBe(true);
	});

	test("leaves an unhandled key untouched", () => {
		const list = items(3);
		const e = key("a");
		expect(moveRovingFocus(e as unknown as KeyboardEvent, list, 0, "vertical")).toBeNull();
		expect(e.prevented).toBe(false);
		expect(list.some((el) => el.focused)).toBe(false);
	});
});
