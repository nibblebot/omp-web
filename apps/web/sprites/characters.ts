/**
 * Character registry: maps a model (provider id, then model id) to its
 * pixel-art character.
 *
 * The empty-state greeting and the model-role picker both resolve the
 * character here. Each character carries an explicit `matches` predicate over
 * a lowercased key: provider-family characters (minimax, deepseek, kimi) match
 * by prefix, while model-family characters (opus, sonnet) match by substring
 * of the model id because their provider is `anthropic` or a gateway
 * (openrouter, Bedrock `anthropic.claude-opus-...`, Vertex `claude-sonnet-...@`).
 * Unknown models fall back to the default "omp" character.
 */
import { DEEPSEEK_SPRITE } from "./deepseek-sprite";
import { DEFAULT_SPRITE } from "./default-sprite";
import { KIMI_SPRITE } from "./kimi-sprite";
import { MINIMAX_SPRITE } from "./minimax-sprite";
import { OPUS_SPRITE } from "./opus-sprite";
import { SONNET_SPRITE } from "./sonnet-sprite";
import type { SpriteArt } from "./sprite";

interface Character {
	/** Stable identity of the character (not a provider prefix). */
	id: string;
	/** Character display name (e.g. the empty-state greeting). */
	name: string;
	/** True when the lowercased provider or model-id key selects this character. */
	matches(key: string): boolean;
	art: SpriteArt;
}

/** Fallback for unknown/undefined models; never matches a key on its own. */
const DEFAULT_CHARACTER: Character = {
	id: "omp",
	name: "omp",
	matches: () => false,
	art: DEFAULT_SPRITE,
};

export const CHARACTERS: readonly Character[] = [
	{ id: "minimax", name: "minimax", matches: (k) => k.startsWith("minimax"), art: MINIMAX_SPRITE },
	{
		id: "deepseek",
		name: "deepseek",
		matches: (k) => k.startsWith("deepseek"),
		art: DEEPSEEK_SPRITE,
	},
	{ id: "kimi", name: "kimi", matches: (k) => k.startsWith("kimi"), art: KIMI_SPRITE },
	{ id: "opus", name: "opus", matches: (k) => k.includes("opus"), art: OPUS_SPRITE },
	{ id: "sonnet", name: "sonnet", matches: (k) => k.includes("sonnet"), art: SONNET_SPRITE },
	DEFAULT_CHARACTER,
];

/** Character for a model; unknown/undefined models fall back to the default
 *  "omp" character. The provider key is tried first, then the model `id`, so
 *  gateway providers ("opencode-go" + "deepseek-v4-flash") still resolve to the
 *  model's own character while a provider match wins over the id. */
export function characterForModel(provider: string | undefined, id?: string): Character {
	for (const key of [provider, id]) {
		if (!key) continue;
		const lower = key.toLowerCase();
		const match = CHARACTERS.find((c) => c.matches(lower));
		if (match) return match;
	}
	return DEFAULT_CHARACTER;
}
