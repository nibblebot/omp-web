/**
 * Shared 16-bit-style pixel-art sprite engine (the "kimi avatar" style).
 *
 * Sprites are 32x32 ASCII maps over a 16-color palette; render 1px = 1 canvas
 * unit and upscale via CSS (`image-rendering: pixelated`), integer scale only.
 *
 * A character exposes six poses: idle/blink at rest, work1/work2/work-blink
 * cycled while the agent is streaming, happy briefly when a stream finishes.
 * Each character module (kimi-sprite, minimax-sprite, deepseek-sprite) defines
 * its own SpriteArt; characters.ts maps model providers to characters.
 */

export type PetPose = "idle" | "blink" | "work1" | "work2" | "work-blink" | "happy";

const PET_POSES: readonly PetPose[] = [
	"idle",
	"blink",
	"work1",
	"work2",
	"work-blink",
	"happy",
];

export const SPRITE_SIZE = 32;

/** One character's pixel art: palette + one 32x32 ASCII map per pose. */
export interface SpriteArt {
	/** ASCII char → CSS color; every char used in `poses` MUST have a key. */
	palette: Record<string, string>;
	/** Six poses, each exactly SPRITE_SIZE rows of exactly SPRITE_SIZE chars. */
	poses: Record<PetPose, string[]>;
}

/** Paints `pose` of `art` onto a 32x32 canvas context (clears first). */
export function drawSprite(ctx: CanvasRenderingContext2D, art: SpriteArt, pose: PetPose): void {
	ctx.clearRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
	const rows = art.poses[pose];
	for (let y = 0; y < SPRITE_SIZE; y++) {
		const row = rows[y];
		for (let x = 0; x < SPRITE_SIZE; x++) {
			const color = art.palette[row[x]];
			if (!color) continue;
			ctx.fillStyle = color;
			ctx.fillRect(x, y, 1, 1);
		}
	}
}
