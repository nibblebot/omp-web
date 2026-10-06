import { describe, expect, test } from "bun:test";
import { CHARACTERS, characterForModel } from "../../sprites/characters";
import { SPRITE_SIZE } from "../../sprites/sprite";

describe("character sprites", () => {
	test("every pose is a SPRITE_SIZE x SPRITE_SIZE grid with a complete, bounded palette", () => {
		for (const character of CHARACTERS) {
			const paletteKeys = new Set(Object.keys(character.art.palette));
			expect(paletteKeys.size).toBeLessThanOrEqual(16);
			// The six-pose set (idle/blink/work1/work2/work-blink/happy) is
			// pinned by the exported SpriteArt.poses: Record<PetPose, string[]>
			// type; validate the grid/palette contract for every pose.
			for (const rows of Object.values(character.art.poses)) {
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

describe("characterForModel", () => {
	test('prefix-maps "minimax-code" to the minimax character', () => {
		expect(characterForModel("minimax-code").id).toBe("minimax");
	});

	test('maps "DEEPSEEK" to the deepseek character (case-insensitive)', () => {
		expect(characterForModel("DEEPSEEK").id).toBe("deepseek");
	});

	test("provider-family characters match by prefix, not substring", () => {
		expect(characterForModel("my-kimi-proxy").id).toBe("omp");
	});

	test("falls back to omp for an undefined provider", () => {
		expect(characterForModel(undefined).id).toBe("omp");
	});

	test("falls back to omp for an unknown model", () => {
		expect(characterForModel("openai", "gpt-5").id).toBe("omp");
		expect(characterForModel("anthropic", "claude-haiku-4-5").id).toBe("omp");
	});

	test("falls back to the model id for gateway providers", () => {
		expect(characterForModel("opencode-go", "deepseek-v4-flash").id).toBe("deepseek");
	});

	test("provider match wins over the model id", () => {
		expect(characterForModel("minimax-code", "deepseek-v4-flash").id).toBe("minimax");
	});

	test("Claude families match by model-id substring across providers", () => {
		expect(characterForModel("anthropic", "claude-opus-4-5").id).toBe("opus");
		expect(characterForModel("bedrock", "anthropic.claude-opus-4-1-v1:0").id).toBe("opus");
		expect(characterForModel("openrouter", "anthropic/claude-sonnet-4.5").id).toBe("sonnet");
		expect(characterForModel("vertex", "claude-sonnet-4@20250514").id).toBe("sonnet");
	});
});
