import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MAGIC_KEYWORDS as SDK_MAGIC_KEYWORDS } from "@oh-my-pi/pi-coding-agent/modes/magic-keywords";
import {
	magicKeywordRanges as sdkMagicKeywordRanges,
	setMagicKeywords as sdkSetMagicKeywords,
} from "@oh-my-pi/pi-tui/prompt/magic-keywords";
import { maskNonProse as sdkMaskNonProse } from "@oh-my-pi/pi-tui/prompt/markdown-prose";
import {
	MAGIC_KEYWORDS,
	magicKeywordGradient,
	magicKeywordRanges,
	magicKeywordSegments,
} from "../../prompt/magic-keywords";
import { maskNonProse } from "../../prompt/prose-mask";

/** Inputs covering every shape the keyword scanner must handle. */
const CORPUS: readonly string[] = [
	"",
	"plain prose with no keyword at all",
	"Please ultrathink about this design.",
	"ultrathink",
	"Use `ultrathink` inline, then orchestrate it.",
	"```ts\nconst x = 'ultrathink';\n```\nNow ultrathink.",
	"~~~\norchestrate\n~~~\njevify this",
	"<note>ultrathink inside xml</note> and jevify outside",
	"<div><div>ultrathink</div> ultrathink</div> ultrathink",
	"ultrathink() and foo::ultrathink and src/ultrathink.ts",
	"ultrathink. ultrathink, \"ultrathink\" 'orchestrate' (jevify)",
	"Ultrathink ULTRATHINK orchestrateX workflowz",
	"```\nunclosed fence ultrathink",
	"`unclosed ultrathink",
	"a < b and ultrathink > c",
	"<!-- ultrathink --> jevify",
	"ultrathink and orchestrate and workflowz and jevify",
	"ultrathink\u00e9 1ultrathink ultrathink-tool ultrathink_x ultrathink/x",
	'<a href="x>ultrathink">link</a> jevify',
];

/** Hand-checked matches: the exact matched substrings, in order. */
const EXPECTED_MATCHES: ReadonlyArray<{ text: string; matches: readonly string[] }> = [
	{ text: "Please ultrathink about this design.", matches: ["ultrathink"] },
	{ text: "Use `ultrathink` inline, then orchestrate it.", matches: ["orchestrate"] },
	{ text: "```ts\nconst x = 'ultrathink';\n```\nNow ultrathink.", matches: ["ultrathink"] },
	{ text: "~~~\norchestrate\n~~~\njevify this", matches: ["jevify"] },
	{ text: "<note>ultrathink inside xml</note> and jevify outside", matches: ["jevify"] },
	{ text: "<div><div>ultrathink</div> ultrathink</div> ultrathink", matches: ["ultrathink"] },
	{ text: "ultrathink() and foo::ultrathink and src/ultrathink.ts", matches: [] },
	{
		text: "ultrathink. ultrathink, \"ultrathink\" 'orchestrate' (jevify)",
		matches: ["ultrathink", "ultrathink", "ultrathink", "orchestrate", "jevify"],
	},
	{ text: "Ultrathink ULTRATHINK orchestrateX workflowz", matches: ["workflowz"] },
	{ text: "```\nunclosed fence ultrathink", matches: [] },
	{ text: "`unclosed ultrathink", matches: ["ultrathink"] },
	{ text: "a < b and ultrathink > c", matches: ["ultrathink"] },
	{ text: "<!-- ultrathink --> jevify", matches: ["jevify"] },
	{
		text: "ultrathink and orchestrate and workflowz and jevify",
		matches: ["ultrathink", "orchestrate", "workflowz", "jevify"],
	},
	{ text: "ultrathink\u00e9 1ultrathink ultrathink-tool ultrathink_x ultrathink/x", matches: [] },
	{ text: '<a href="x>ultrathink">link</a> jevify', matches: ["jevify"] },
];

describe("drift guard", () => {
	test("MAGIC_KEYWORDS equals the SDK table (id, word, hue)", () => {
		expect(MAGIC_KEYWORDS.map(({ id, word, hue }) => ({ id, word, hue: [...hue] }))).toEqual(
			SDK_MAGIC_KEYWORDS.map(({ id, word, hue }) => ({ id, word, hue: [...hue] })),
		);
	});
});

describe("parity with the pi-tui engine", () => {
	beforeAll(() => {
		sdkSetMagicKeywords(SDK_MAGIC_KEYWORDS);
	});
	afterAll(() => {
		sdkSetMagicKeywords([]);
	});

	for (const text of CORPUS) {
		test(`maskNonProse and magicKeywordRanges agree with the SDK on ${JSON.stringify(text)}`, () => {
			expect(maskNonProse(text)).toBe(sdkMaskNonProse(text));
			expect(magicKeywordRanges(text).map(({ from, to }) => ({ from, to }))).toEqual(
				sdkMagicKeywordRanges(text),
			);
		});
	}

	for (const { text, matches } of EXPECTED_MATCHES) {
		test(`SDK finds the same hand-checked matches in ${JSON.stringify(text)}`, () => {
			expect(sdkMagicKeywordRanges(text).map((r) => text.slice(r.from, r.to))).toEqual([
				...matches,
			]);
		});
	}
});

describe("magicKeywordRanges", () => {
	for (const { text, matches } of EXPECTED_MATCHES) {
		test(`matches ${JSON.stringify(matches)} in ${JSON.stringify(text)}`, () => {
			expect(magicKeywordRanges(text).map((r) => text.slice(r.from, r.to))).toEqual([...matches]);
		});
	}

	test("ranges are sorted by from and carry the keyword id", () => {
		const ranges = magicKeywordRanges("jevify then ultrathink");
		expect(ranges).toEqual([
			{ from: 0, to: 6, id: "jevify" },
			{ from: 12, to: 22, id: "ultrathink" },
		]);
	});

	test("enabled filter keeps only the keywords the predicate enables", () => {
		const text = "ultrathink and orchestrate and jevify";
		expect(magicKeywordRanges(text, (id) => id !== "ultrathink").map((r) => r.id)).toEqual([
			"orchestrate",
			"jevify",
		]);
	});

	test("an all-disabled predicate yields no ranges", () => {
		expect(magicKeywordRanges("ultrathink", () => false)).toEqual([]);
	});
});

describe("magicKeywordSegments", () => {
	test("splits prose into plain and keyword segments", () => {
		expect(magicKeywordSegments("Use ultrathink, then `orchestrate` and jevify.")).toEqual([
			{ text: "Use " },
			{ text: "ultrathink", id: "ultrathink" },
			{ text: ", then `orchestrate` and " },
			{ text: "jevify", id: "jevify" },
			{ text: "." },
		]);
	});

	test("empty text yields no segments", () => {
		expect(magicKeywordSegments("")).toEqual([]);
	});

	test("a disabled keyword stays inside a plain segment", () => {
		expect(magicKeywordSegments("ultrathink", () => false)).toEqual([{ text: "ultrathink" }]);
	});

	for (const text of CORPUS) {
		test(`segments reassemble to the original text: ${JSON.stringify(text)}`, () => {
			expect(
				magicKeywordSegments(text)
					.map((segment) => segment.text)
					.join(""),
			).toBe(text);
		});
	}
});

describe("magicKeywordGradient", () => {
	test("emits a 90deg linear gradient with 14 HSL stops", () => {
		const gradient = magicKeywordGradient("ultrathink");
		expect(gradient.startsWith("linear-gradient(90deg, hsl(0, 85%, 55%)")).toBe(true);
		expect(gradient.endsWith(")")).toBe(true);
		expect(gradient.match(/hsl\(/g)?.length).toBe(14);
	});

	test("sweeps each keyword hue from its start toward its end", () => {
		for (const {
			id,
			hue: [from, to],
		} of MAGIC_KEYWORDS) {
			const stops: string[] = magicKeywordGradient(id).match(/hsl\([^)]*\)/g) ?? [];
			const expected = Array.from(
				{ length: 14 },
				(_, i) => `hsl(${Math.round((from + (i / 14) * (to - from)) % 360)}, 85%, 55%)`,
			);
			expect(stops).toEqual(expected);
		}
	});

	test("jevify wraps past 360: stop 7 lands on hue 0", () => {
		expect(magicKeywordGradient("jevify").match(/hsl\([^)]*\)/g)?.[7]).toBe("hsl(0, 85%, 55%)");
	});
});
