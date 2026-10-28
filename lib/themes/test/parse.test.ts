import { describe, expect, test } from "bun:test";
import { parseThemeFile } from "../parse";
import { THEME_CORE_TOKENS, THEME_TOKENS } from "../types";
import { DARK_CORE, LIGHT_CORE, themeDoc } from "./fixtures.testkit";

function errorsOf(stem: string, raw: unknown): string[] {
	const result = parseThemeFile(stem, raw, "custom");
	if (result.ok) throw new Error("expected parse failure");
	return result.errors;
}

describe("parseThemeFile accepts", () => {
	test("a core-only theme and resolves every token of every variant", () => {
		const result = parseThemeFile("mine", themeDoc("Mine"), "custom");
		if (!result.ok) throw new Error(result.errors.join("\n"));
		expect(result.entry).toMatchObject({ id: "mine", name: "Mine", source: "custom" });
		for (const scheme of ["dark", "light"] as const) {
			const variant = result.entry.variants[scheme]!;
			expect(variant.scheme).toBe(scheme);
			for (const token of THEME_TOKENS)
				expect(variant.tokens[token]).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$|^oklch\(/);
		}
	});

	test("a single-variant theme, an optional $schema and every color format", () => {
		const doc = {
			$schema: "../schema.json",
			schemaVersion: 1,
			name: "  Padded  ",
			variants: {
				light: {
					...LIGHT_CORE,
					bg: "#fff",
					panel: "oklch(98% 0.01 90)",
					border: "oklch(50% 0.02 90 / 0.3)",
					accent: "#1a55d6cc",
				},
			},
		};
		const result = parseThemeFile("one-variant-2", doc, "builtin");
		if (!result.ok) throw new Error(result.errors.join("\n"));
		expect(result.entry.name).toBe("Padded");
		expect(result.entry.source).toBe("builtin");
		expect(result.entry.variants.dark).toBeUndefined();
		expect(result.entry.variants.light?.tokens.panel).toBe("oklch(98% 0.01 90)");
	});
});

describe("parseThemeFile rejects", () => {
	test("a newer schema version with a clear error", () => {
		const errors = errorsOf("mine", { ...themeDoc("Mine"), schemaVersion: 2 });
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/^schemaVersion: 2 is newer than this omp-web supports \(1\)/);
	});

	test.each([undefined, "1", 1.5, 0, -1, null])("a bad schemaVersion %p", (schemaVersion) => {
		const doc = { ...themeDoc("Mine"), schemaVersion };
		expect(errorsOf("mine", doc).some((e) => e.startsWith("schemaVersion: required integer"))).toBe(
			true,
		);
	});

	test("a missing core token, naming the variant and token", () => {
		const { accent: _accent, ...rest } = DARK_CORE;
		const errors = errorsOf("mine", { schemaVersion: 1, name: "X", variants: { dark: rest } });
		expect(errors).toEqual(["variants.dark.accent: missing required token"]);
	});

	test("an unknown token and an unknown variant", () => {
		const errors = errorsOf("mine", {
			schemaVersion: 1,
			name: "X",
			variants: { dark: { ...DARK_CORE, "not-a-token": "#fff" }, sepia: { ...DARK_CORE } },
		});
		expect(errors).toContain("variants.dark.not-a-token: unknown token");
		expect(errors).toContain("variants.sepia: unknown variant (expected dark or light)");
	});

	test.each(["rgb(1, 2, 3)", "red", "#abcd", "hsl(1 2% 3%)", "oklch(70 0.1 200)", 12, null, ""])(
		"a bad color %p",
		(value) => {
			const errors = errorsOf("mine", {
				schemaVersion: 1,
				name: "X",
				variants: { dark: { ...DARK_CORE, accent: value } },
			});
			expect(errors).toHaveLength(1);
			expect(errors[0]).toStartWith("variants.dark.accent: not a color");
		},
	);

	test("a bad color on an optional token", () => {
		const errors = errorsOf("mine", {
			schemaVersion: 1,
			name: "X",
			variants: { dark: { ...DARK_CORE, "tool-shell": "purple" } },
		});
		expect(errors[0]).toStartWith("variants.dark.tool-shell: not a color");
	});

	test("empty variants, a non-object variants and a non-object variant", () => {
		expect(errorsOf("mine", { schemaVersion: 1, name: "X", variants: {} })).toEqual([
			"variants: must define at least one of dark, light",
		]);
		expect(errorsOf("mine", { schemaVersion: 1, name: "X", variants: [] })[0]).toStartWith(
			"variants: required object",
		);
		expect(errorsOf("mine", { schemaVersion: 1, name: "X" })[0]).toStartWith(
			"variants: required object",
		);
		expect(errorsOf("mine", { schemaVersion: 1, name: "X", variants: { dark: "#000" } })).toEqual([
			"variants.dark: expected an object of color tokens",
		]);
	});

	test.each(["My Theme", "UPPER", "under_score", "dot.name", ""])("a bad stem %p", (stem) => {
		const errors = errorsOf(stem, themeDoc("X"));
		expect(errors).toHaveLength(1);
		expect(errors[0]).toStartWith("file name:");
	});

	test("a bad name, unknown top-level keys and a bad $schema", () => {
		const errors = errorsOf("mine", { ...themeDoc("X"), name: "   ", extra: 1, $schema: 5 });
		expect(errors).toContain("name: required non-empty string");
		expect(errors).toContain("extra: unknown key");
		expect(errors).toContain("$schema: expected a string");
	});

	test("anything that is not a JSON object", () => {
		for (const raw of [null, [], "theme", 4])
			expect(errorsOf("mine", raw)).toContain("file: expected a JSON object");
	});

	test("collects every error, not just the first", () => {
		const { accent: _accent, error: _error, ...rest } = DARK_CORE;
		const errors = errorsOf("Bad Stem", {
			schemaVersion: 1,
			name: "",
			extra: true,
			variants: {
				dark: { ...rest, text: "rgb(0,0,0)", bogus: "#fff" },
				light: { ...LIGHT_CORE, muted: "blue" },
			},
		});
		expect(errors.map((e) => e.split(":")[0])).toEqual([
			"file name",
			"extra",
			"name",
			"variants.dark.accent",
			"variants.dark.error",
			"variants.dark.text",
			"variants.dark.bogus",
			"variants.light.muted",
		]);
	});

	test("the core token list is what the validator requires", () => {
		const errors = errorsOf("mine", { schemaVersion: 1, name: "X", variants: { dark: {} } });
		expect(errors).toEqual(
			THEME_CORE_TOKENS.map((token) => `variants.dark.${token}: missing required token`),
		);
	});
});
