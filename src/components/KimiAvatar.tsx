import { onMount, type Component } from "solid-js";
import { drawKimi, KIMI_SPRITE_SIZE, type KimiPose } from "../kimi-sprite";

/** Static 16x16 (default) pixel-art kimi avatar; 32x32 canvas upscaled via CSS. */
export const KimiAvatar: Component<{ pose?: KimiPose; size?: number }> = props => {
	const size = props.size ?? 16;
	let canvas!: HTMLCanvasElement;
	onMount(() => drawKimi(canvas.getContext("2d")!, props.pose ?? "idle"));
	return (
		<canvas
			ref={el => (canvas = el)}
			width={KIMI_SPRITE_SIZE}
			height={KIMI_SPRITE_SIZE}
			style={{ width: `${size}px`, height: `${size}px`, "image-rendering": "pixelated" }}
		/>
	);
};
