/**
 * Character registry: maps a model provider id to its pixel-art character.
 *
 * The corner pet and sidebar avatars both resolve the character for the
 * session's model provider here; unknown providers fall back to kimi, which
 * preserves the original always-kimi behavior.
 */
import { DEEPSEEK_SPRITE } from "./deepseek-sprite";
import { KIMI_SPRITE } from "./kimi-sprite";
import { MINIMAX_SPRITE } from "./minimax-sprite";
import { drawSprite, type PetPose, type SpriteArt } from "./sprite";

export interface Character {
	/** Model provider id (lowercase) that selects this character; the last
	 *  entry is the fallback for unknown/undefined providers. */
	provider: string;
	/** Label shown under the corner pet. */
	name: string;
	art: SpriteArt;
}

export const CHARACTERS: readonly Character[] = [
	{ provider: "minimax", name: "minimax", art: MINIMAX_SPRITE },
	{ provider: "deepseek", name: "deepseek", art: DEEPSEEK_SPRITE },
	{ provider: "kimi", name: "kimi", art: KIMI_SPRITE },
];

/** Character for a model provider; unknown/undefined providers fall back to kimi.
 *  Prefix match (e.g. "minimax-code" → minimax) since registry provider ids
 *  vary by deployment ("minimax" vs "minimax-code"). */
export function characterForProvider(provider: string | undefined): Character {
	if (!provider) return CHARACTERS[CHARACTERS.length - 1];
	const match = CHARACTERS.find(c => provider.toLowerCase().startsWith(c.provider));
	return match ?? CHARACTERS[CHARACTERS.length - 1];
}

/** Paints `pose` of `character` onto a 32x32 canvas context (clears first). */
export function drawCharacter(ctx: CanvasRenderingContext2D, character: Character, pose: PetPose): void {
	drawSprite(ctx, character.art, pose);
}
