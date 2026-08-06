import { onMount, type Component } from "solid-js";
import { characterForProvider, drawCharacter } from "../characters";
import { SPRITE_SIZE, type PetPose } from "../sprite";

/** Static pixel-art avatar for a session's model provider; 32x32 canvas upscaled via CSS. */
export const CharacterAvatar: Component<{ provider?: string; pose?: PetPose; size?: number }> = props => {
	const size = props.size ?? 16;
	let canvas!: HTMLCanvasElement;
	onMount(() => drawCharacter(canvas.getContext("2d")!, characterForProvider(props.provider), props.pose ?? "idle"));
	return (
		<canvas
			ref={el => (canvas = el)}
			width={SPRITE_SIZE}
			height={SPRITE_SIZE}
			style={{ width: `${size}px`, height: `${size}px`, "image-rendering": "pixelated" }}
		/>
	);
};
