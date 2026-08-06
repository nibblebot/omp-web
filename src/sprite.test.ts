import { describe, expect, test } from "bun:test";
import { CHARACTERS, characterForProvider } from "./characters";
import { PET_POSES, SPRITE_SIZE } from "./sprite";

describe("character sprites", () => {
	test("every pose is a SPRITE_SIZE x SPRITE_SIZE grid with a complete, bounded palette", () => {
		for (const character of CHARACTERS) {
			const paletteKeys = new Set(Object.keys(character.art.palette));
			expect(paletteKeys.size).toBeLessThanOrEqual(16);
			for (const pose of PET_POSES) {
				const rows = character.art.poses[pose];
				expect(rows).toHaveLength(SPRITE_SIZE);
				for (const row of rows) {
					expect(row).toHaveLength(SPRITE_SIZE);
					for (const ch of row) {
						// "." is the transparent background char: drawSprite skips
						// chars without a palette entry, so it needs no key.
						if (ch === ".") continue;
						expect(paletteKeys.has(ch)).toBe(true);
					}
				}
			}
		}
	});
});

describe("characterForProvider", () => {
	test('maps "minimax" to the minimax character', () => {
		expect(characterForProvider("minimax").provider).toBe("minimax");
	});

	test('prefix-maps "minimax-code" to the minimax character', () => {
		expect(characterForProvider("minimax-code").provider).toBe("minimax");
	});

	test('maps "DEEPSEEK" to the deepseek character (case-insensitive)', () => {
		expect(characterForProvider("DEEPSEEK").provider).toBe("deepseek");
	});

	test('prefix-maps "kimi-code" to the kimi character', () => {
		expect(characterForProvider("kimi-code").provider).toBe("kimi");
	});

	test("falls back to kimi for an undefined provider", () => {
		expect(characterForProvider(undefined).provider).toBe("kimi");
	});

	test('falls back to kimi for an unknown provider like "openai"', () => {
		expect(characterForProvider("openai").provider).toBe("kimi");
	});
});
