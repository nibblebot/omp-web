import { describe, expect, test } from "bun:test";
import { composite, contrastRatio, hslHue, parseColor } from "../color";
import type { Rgb } from "../color";
import { contrastWarnings, SYNTAX_TOKENS, TOOL_TOKENS } from "../contrast";
import { parseThemeFile } from "../parse";
import { THEME_CORE_TOKENS } from "../types";
import type { ThemeContrastWarning, ThemeScheme, ThemeToken, ThemeVariant } from "../types";
import { DARK_CORE, LIGHT_CORE, MURKY_DARK_CORE, MURKY_LIGHT_CORE } from "./fixtures.testkit";

function resolve(
	scheme: ThemeScheme,
	core: Record<string, string>,
	extra: Record<string, string> = {},
): ThemeVariant {
	const doc = { schemaVersion: 1, name: "T", variants: { [scheme]: { ...core, ...extra } } };
	const result = parseThemeFile("t", doc, "custom");
	if (!result.ok) throw new Error(result.errors.join("\n"));
	return result.entry.variants[scheme]!;
}

function color(variant: ThemeVariant, token: ThemeToken): Rgb {
	return parseColor(variant.tokens[token])!;
}

function warnings(variant: ThemeVariant): ThemeContrastWarning[] {
	return contrastWarnings(variant.tokens, variant.scheme);
}

/** The four backgrounds every solved token must clear, measured independently of the report. */
function solvedBackgrounds(variant: ThemeVariant): Rgb[] {
	const panel = composite(color(variant, "panel"), color(variant, "bg"));
	return [
		panel,
		composite(color(variant, "bg-deep"), color(variant, "bg")),
		composite(color(variant, "diff-add-bg"), panel),
		composite(color(variant, "diff-del-bg"), panel),
	];
}

const CORES = [
	["dark", "catppuccin-like dark", DARK_CORE],
	["light", "catppuccin-like light", LIGHT_CORE],
	["dark", "murky dark", MURKY_DARK_CORE],
	["light", "murky light", MURKY_LIGHT_CORE],
] as const;

describe("derived tool and syntax colors", () => {
	for (const [scheme, label, core] of CORES) {
		describe(label, () => {
			const variant = resolve(scheme, core);

			test("reach 4.5:1 on panel, bg-deep and both diff backgrounds", () => {
				const backgrounds = solvedBackgrounds(variant);
				for (const token of [...TOOL_TOKENS, ...SYNTAX_TOKENS]) {
					for (const bg of backgrounds) {
						expect(contrastRatio(color(variant, token), bg), token).toBeGreaterThanOrEqual(4.5);
					}
				}
			});

			test("tool hues avoid red and green", () => {
				for (const token of TOOL_TOKENS) {
					const hue = hslHue(color(variant, token));
					if (hue === null) continue;
					expect(hue >= 340 || hue <= 20, `${token} red at ${hue}`).toBe(false);
					expect(hue >= 75 && hue <= 170, `${token} green at ${hue}`).toBe(false);
				}
			});

			test("derive no contrast warning (only explicit core colors can be flagged)", () => {
				const derived = warnings(variant).filter(
					(w) => w.kind !== "contrast" || !THEME_CORE_TOKENS.some((token) => token === w.fg),
				);
				expect(derived).toEqual([]);
			});

			test("derived secondary text reads on the page and the panel", () => {
				const [bg, panel] = [color(variant, "bg"), solvedBackgrounds(variant)[0]!];
				for (const token of ["muted-2", "muted-3"] as const) {
					expect(contrastRatio(color(variant, token), bg), token).toBeGreaterThanOrEqual(4.5);
					expect(contrastRatio(color(variant, token), panel), token).toBeGreaterThanOrEqual(4.5);
				}
			});

			test("an unreadable explicit core text color is reported", () => {
				const dim = resolve(scheme, core, { muted: core.bg });
				expect(
					warnings(dim).some((w) => w.kind === "contrast" && w.fg === "muted" && w.bg === "bg"),
				).toBe(true);
				// muted-2 / muted-3 still derive to something readable from the failing muted.
				expect(contrastRatio(color(dim, "muted-2"), color(dim, "bg"))).toBeGreaterThanOrEqual(4.5);
			});
		});
	}

	test("light derivations are darker than the page and dark ones lighter", () => {
		const dark = resolve("dark", DARK_CORE);
		const light = resolve("light", LIGHT_CORE);
		expect(contrastRatio(color(dark, "tool-read"), color(dark, "bg-deep"))).toBeGreaterThanOrEqual(
			4.5,
		);
		expect(color(dark, "tool-read").g).toBeGreaterThan(color(dark, "bg").g);
		expect(color(light, "tool-read").g).toBeLessThan(color(light, "bg").g);
	});
});

describe("derived surfaces", () => {
	test("are scheme aware", () => {
		const dark = resolve("dark", DARK_CORE);
		const light = resolve("light", LIGHT_CORE);
		// bg-deep is darker than bg in both schemes
		for (const variant of [dark, light]) {
			const deep = color(variant, "bg-deep");
			const bg = color(variant, "bg");
			expect(deep.r + deep.g + deep.b).toBeLessThan(bg.r + bg.g + bg.b);
		}
		// shimmer band: muted-3 on dark, toward the bg on light
		expect(dark.tokens["shimmer-band"]).toBe(dark.tokens["muted-3"]);
		expect(light.tokens["shimmer-band"]).not.toBe(light.tokens["muted-3"]);
		expect(color(light, "shimmer-band").r).toBeGreaterThan(color(light, "muted-2").r);
	});

	test("shadow and backdrop are translucent, status tints are translucent", () => {
		for (const variant of [resolve("dark", DARK_CORE), resolve("light", LIGHT_CORE)]) {
			for (const token of [
				"shadow-color",
				"backdrop",
				"success-bg",
				"error-bg",
				"diff-add-bg",
				"accent-dim",
			] as const) {
				const alpha = color(variant, token).a;
				expect(alpha, token).toBeGreaterThan(0);
				expect(alpha, token).toBeLessThan(1);
			}
		}
	});

	test("settings mark text is readable on its fill in both schemes", () => {
		for (const variant of [
			resolve("dark", DARK_CORE),
			resolve("light", LIGHT_CORE),
			resolve("dark", MURKY_DARK_CORE),
			resolve("light", MURKY_LIGHT_CORE),
		]) {
			expect(
				contrastRatio(color(variant, "settings-mark-fg"), color(variant, "settings-mark-bg")),
			).toBeGreaterThanOrEqual(4.5);
		}
	});

	test("diff and error text stay readable on their rows", () => {
		for (const [scheme, core] of [
			["dark", MURKY_DARK_CORE],
			["light", MURKY_LIGHT_CORE],
		] as const) {
			const variant = resolve(scheme, core);
			const panel = composite(color(variant, "panel"), color(variant, "bg"));
			for (const [text, bg] of [
				["diff-add-text", "diff-add-bg"],
				["diff-del-text", "diff-del-bg"],
				["error-text", "error-bg"],
			] as const) {
				expect(
					contrastRatio(color(variant, text), composite(color(variant, bg), panel)),
					text,
				).toBeGreaterThanOrEqual(4.5);
			}
		}
	});

	test("derivation is deterministic", () => {
		expect(resolve("dark", DARK_CORE)).toEqual(resolve("dark", DARK_CORE));
	});

	test("derived values follow an explicit token they depend on", () => {
		const base = resolve("dark", DARK_CORE);
		const tinted = resolve("dark", DARK_CORE, { success: "#00ff80" });
		expect(tinted.tokens["diff-add-bg"]).not.toBe(base.tokens["diff-add-bg"]);
		expect(tinted.tokens["success-bg"]).toStartWith("#00ff80");
	});
});

describe("explicit values", () => {
	test("are kept verbatim, in whatever format they were written", () => {
		const variant = resolve("dark", DARK_CORE, {
			"tool-read": "#4a4a4a",
			"syn-keyword": "oklch(30% 0.05 250)",
			"bg-deep": "#000",
			"diff-add-bg": "#00ff0020",
		});
		expect(variant.tokens["tool-read"]).toBe("#4a4a4a");
		expect(variant.tokens["syn-keyword"]).toBe("oklch(30% 0.05 250)");
		expect(variant.tokens["bg-deep"]).toBe("#000");
		expect(variant.tokens["diff-add-bg"]).toBe("#00ff0020");
	});

	test("low contrast produces warnings naming the pair, and never fails parsing", () => {
		const variant = resolve("dark", DARK_CORE, {
			"tool-read": "#4a4a4a",
			"syn-comment": "#35354a",
		});
		const contrast = warnings(variant).flatMap((w) => (w.kind === "contrast" ? [w] : []));
		const toolRead = contrast.filter((w) => w.fg === "tool-read");
		expect(toolRead.map((w) => w.bg)).toEqual(["panel", "bg-deep"]);
		for (const w of toolRead) {
			expect(w.min).toBe(4.5);
			expect(w.ratio).toBeLessThan(4.5);
			expect(w.ratio).toBeGreaterThan(1);
		}
		expect(contrast.some((w) => w.fg === "syn-comment" && w.bg === "diff-add-bg")).toBe(true);
	});

	test("a red or green tool color is flagged as a hue warning", () => {
		const variant = resolve("dark", DARK_CORE, {
			"tool-shell": "#ff6b6b",
			"tool-write": "#7bd88f",
		});
		const hues = warnings(variant).flatMap((w) => (w.kind === "hue" ? [w] : []));
		expect(hues.map((w) => w.token)).toEqual(["tool-shell", "tool-write"]);
		expect(hues[0]!.reason).toContain("red");
		expect(hues[1]!.reason).toContain("green");
	});

	test("weak text and muted on the page surfaces are reported", () => {
		const variant = resolve("dark", { ...DARK_CORE, muted: "#3a3a4e", text: "#505068" });
		const pairs = warnings(variant).flatMap((w) =>
			w.kind === "contrast" ? [`${w.fg}/${w.bg}`] : [],
		);
		expect(pairs).toEqual(
			expect.arrayContaining(["text/bg", "text/panel", "muted/bg", "muted/panel"]),
		);
		expect(pairs).toEqual(expect.arrayContaining(["text/diff-add-bg", "text/diff-del-bg"]));
	});
});
