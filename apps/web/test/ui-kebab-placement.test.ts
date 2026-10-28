import { describe, expect, test } from "bun:test";
import { kebabSide } from "../components/ui/kebab-placement";

const band = { top: 100, bottom: 600 };

describe("kebabSide", () => {
	test("opens below when the whole menu fits under the trigger", () => {
		expect(kebabSide({ top: 150, bottom: 190 }, band, 200)).toBe("below");
	});

	test("a trigger on the last rows flips the menu above", () => {
		expect(kebabSide({ top: 540, bottom: 580 }, band, 200)).toBe("above");
	});

	test("stays below when neither side fits and above is no roomier", () => {
		expect(kebabSide({ top: 110, bottom: 150 }, band, 600)).toBe("below");
	});

	test("a menu that exactly fits below does not flip", () => {
		expect(kebabSide({ top: 360, bottom: 400 }, band, 200)).toBe("below");
	});
});
