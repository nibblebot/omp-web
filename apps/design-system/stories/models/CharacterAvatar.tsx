import { For } from "solid-js";
import { CharacterAvatar } from "../../../web/components/models/CharacterAvatar";
import { CHARACTERS } from "../../../web/sprites/characters";
import type { PetPose } from "../../../web/sprites/sprite";
import { defineStory } from "../../registry";

/** Provider and model id that resolve each character through characterForModel. */
const SELECTORS: Record<string, { provider?: string; id?: string }> = {
	minimax: { provider: "minimax" },
	deepseek: { provider: "deepseek" },
	kimi: { provider: "kimi", id: "kimi-k2" },
	opus: { provider: "anthropic", id: "claude-opus-4-1" },
	sonnet: { provider: "anthropic", id: "claude-sonnet-4-5" },
	omp: {},
};

const POSES: PetPose[] = ["idle", "blink", "work1", "work2", "work-blink", "happy"];

export default defineStory({
	id: "models-character-avatar",
	title: "CharacterAvatar",
	component: { file: "apps/web/components/models/CharacterAvatar.tsx", export: "CharacterAvatar" },
	variants: [
		...CHARACTERS.map((character) => {
			const selector = SELECTORS[character.id];
			return {
				name: character.name,
				description: `Provider "${selector?.provider ?? "none"}"${selector?.id ? `, model id "${selector.id}"` : ""}.`,
				render: () => <CharacterAvatar provider={selector?.provider} id={selector?.id} size={96} />,
			};
		}),
		{
			name: "Poses",
			description: "Every pose for the Sonnet sprite, drawn at 64px.",
			render: () => (
				<div>
					<For each={POSES}>
						{(pose) => (
							<div>
								<CharacterAvatar
									provider="anthropic"
									id="claude-sonnet-4-5"
									pose={pose}
									size={64}
								/>
								<span class="ds-chip-note"> {pose}</span>
							</div>
						)}
					</For>
				</div>
			),
		},
	],
});
