/**
 * Character registry: maps a model provider id to its pixel-art character.
 *
 * The empty-state greeting and the model-role picker both resolve the
 * character for a model's provider here; unknown providers fall back to kimi, which
 * preserves the original always-kimi behavior.
 */
import { DEEPSEEK_SPRITE } from "./deepseek-sprite";
import { KIMI_SPRITE } from "./kimi-sprite";
import { MINIMAX_SPRITE } from "./minimax-sprite";
import type { SpriteArt } from "./sprite";

interface Character {
	/** Model provider id (lowercase) that selects this character; the last
	 *  entry is the fallback for unknown/undefined providers. */
	provider: string;
	/** Character display name (e.g. the empty-state greeting). */
	name: string;
	art: SpriteArt;
}

export const CHARACTERS: readonly Character[] = [
	{ provider: "minimax", name: "minimax", art: MINIMAX_SPRITE },
	{ provider: "deepseek", name: "deepseek", art: DEEPSEEK_SPRITE },
	{ provider: "kimi", name: "kimi", art: KIMI_SPRITE },
];

/** Character for a model; unknown/undefined providers fall back to kimi.
 *  Prefix match (e.g. "minimax-code" → minimax) since registry provider ids
 *  vary by deployment ("minimax" vs "minimax-code"). The model `id` is tried
 *  after the provider so gateway providers ("opencode-go/deepseek-v4-flash")
 *  still resolve to the model's own character. */
export function characterForProvider(provider: string | undefined, id?: string): Character {
	for (const key of [provider, id]) {
		if (!key) continue;
		const match = CHARACTERS.find((c) => key.toLowerCase().startsWith(c.provider));
		if (match) return match;
	}
	return CHARACTERS[CHARACTERS.length - 1];
}
