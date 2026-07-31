/**
 * Kimi — 16-bit style pixel-art catgirl avatar.
 *
 * Sprites are 32x32 ASCII maps over a 16-color palette; render 1px = 1 canvas
 * unit and upscale via CSS (`image-rendering: pixelated`), integer scale only.
 *
 * Poses: idle/blink for at rest, work1/work2/work-blink cycled while the agent
 * is streaming, happy briefly when a stream finishes.
 */

export type KimiPose = "idle" | "blink" | "work1" | "work2" | "work-blink" | "happy";

export const KIMI_POSES: readonly KimiPose[] = ["idle", "blink", "work1", "work2", "work-blink", "happy"];

export const KIMI_SPRITE_SIZE = 32;

const PALETTE: Record<string, string> = {
	o: "#2a2333", // outline (dark plum)
	h: "#a8b4f0", // hair base (silver-lavender)
	H: "#7983c9", // hair shadow / tail
	w: "#e4eaff", // hair highlight
	s: "#ffd9c2", // skin
	e: "#2fc4be", // eye iris (teal)
	E: "#146b6d", // eye dark
	g: "#ffffff", // eye sparkle
	p: "#f5a3c0", // inner ear / bow pink
	b: "#ff9eb5", // blush
	m: "#c25a6e", // mouth / bow knot
	d: "#424a75", // outfit (navy)
	D: "#2e3454", // outfit shade
	r: "#e85d75", // bow knot red
};

const POSES: Record<KimiPose, string[]> = {
	idle: [
		"................................",
		"........o..............o........",
		".......oho............oho.......",
		"......oppho..........ohppo......",
		"......oppho..........ohppo......",
		".....ohhhhho........ohhhhho.....",
		"......oooooooooooooooooooo......",
		".....owwhhhhhhhhhhhhhhhhwwo.....",
		"....owwhhhhhhhhhhhhhhhhhhwwo....",
		"....ohhhsssssssssssssssshhho....",
		"....ohhsssssssssssssssssshho....",
		"....ohhsssEEEssssssEEEssshho....",
		"....ohhsssgeEssssssEegssshho....",
		"....ohhssseeesssssseeessshho....",
		"....ohhssbbssssssssssbbsshho....",
		"....ohhhsssssssmmssssssshhho....",
		".....ohhsssssssssssssssshho.....",
		".....ohooooooooooooooooooho..oo.",
		"....ohh..odoppprrpppodo..hhooHo.",
		"....ohh..ododpprrppdodo..hhoHHo.",
		"....oh...ododdddddddodo...hoHHo.",
		".........ododdddddddodo...oHHo..",
		".........ododdddddddodo..oHHo...",
		".........osoddddddddosooHHo.....",
		"...........oddddddddooHHo.......",
		"...........oDDDDDDDDooHo........",
		"...........oooooooooo...........",
		"............osso.osso...........",
		"............osso.osso...........",
		"............oooo.oooo...........",
		"................................",
		"................................",
	],
	blink: [
		"................................",
		"........o..............o........",
		".......oho............oho.......",
		"......oppho..........ohppo......",
		"......oppho..........ohppo......",
		".....ohhhhho........ohhhhho.....",
		"......oooooooooooooooooooo......",
		".....owwhhhhhhhhhhhhhhhhwwo.....",
		"....owwhhhhhhhhhhhhhhhhhhwwo....",
		"....ohhhsssssssssssssssshhho....",
		"....ohhsssssssssssssssssshho....",
		"....ohhsssssssssssssssssshho....",
		"....ohhsssooossssssooossshho....",
		"....ohhsssssssssssssssssshho....",
		"....ohhssbbssssssssssbbsshho....",
		"....ohhhsssssssmmssssssshhho....",
		".....ohhsssssssssssssssshho.....",
		".....ohooooooooooooooooooho..oo.",
		"....ohh..odoppprrpppodo..hhooHo.",
		"....ohh..ododpprrppdodo..hhoHHo.",
		"....oh...ododdddddddodo...hoHHo.",
		".........ododdddddddodo...oHHo..",
		".........ododdddddddodo..oHHo...",
		".........osoddddddddosooHHo.....",
		"...........oddddddddooHHo.......",
		"...........oDDDDDDDDooHo........",
		"...........oooooooooo...........",
		"............osso.osso...........",
		"............osso.osso...........",
		"............oooo.oooo...........",
		"................................",
		"................................",
	],
	work1: [
		"................................",
		"........o..............o........",
		".......oho............oho.......",
		"......oppho..........ohppo......",
		"......oppho..........ohppo......",
		".....ohhhhho........ohhhhho.....",
		"......oooooooooooooooooooo......",
		".....owwhhhhhhhhhhhhhhhhwwo.....",
		"....owwhhhhhhhhhhhhhhhhhhwwo....",
		"....ohhhsssssssssssssssshhho....",
		"....ohhsssssssssssssssssshho....",
		"....ohhsssEEEssssssEEEssshho....",
		"....ohhsssgeEssssssEegssshho....",
		"....ohhssseeesssssseeessshho....",
		"....ohhssbbssssssssssbbsshho....",
		"....ohhhsssssssmmssssssshhho....",
		".....ohhsssssssssssssssshho.....",
		".....ohooooooooooooooooooho..oo.",
		"....ohh..odoppprrpppodo..hhooHo.",
		"....ohh..ododpprrppdodo..hhoHHo.",
		"....oh...ododdddddddodo...hoHHo.",
		".........ododdddddddodo...oHHo..",
		".........ododdddddddodo..oHHo...",
		"...........oddddddddosooHHo.....",
		"...........oddddddddooHHo.......",
		"...........oDDDDDDDDooHo........",
		"...........oooooooooo...........",
		"............osso.osso...........",
		"............osso.osso...........",
		"............oooo.oooo...........",
		"................................",
		"................................",
	],
	work2: [
		"................................",
		"........o..............o........",
		".......oho............oho.......",
		"......oppho..........ohppo......",
		"......oppho..........ohppo......",
		".....ohhhhho........ohhhhho.....",
		"......oooooooooooooooooooo......",
		".....owwhhhhhhhhhhhhhhhhwwo.....",
		"....owwhhhhhhhhhhhhhhhhhhwwo....",
		"....ohhhsssssssssssssssshhho....",
		"....ohhsssssssssssssssssshho....",
		"....ohhsssEEEssssssEEEssshho....",
		"....ohhsssgeEssssssEegssshho....",
		"....ohhssseeesssssseeessshho....",
		"....ohhssbbssssssssssbbsshho....",
		"....ohhhsssssssmmssssssshhho....",
		".....ohhsssssssssssssssshho.....",
		".....ohooooooooooooooooooho.....",
		"....ohh..odoppprrpppodo..hho....",
		"....ohh..ododpprrppdodo..hhoHHo.",
		"....oh...ododdddddddodo...hoHHo.",
		".........ododdddddddodo...oHHo..",
		".........ododdddddddoso..oHHo...",
		".........osoddddddddo..oHHo.....",
		"...........oddddddddooHHo.......",
		"...........oDDDDDDDDooHo........",
		"...........oooooooooo...........",
		"............osso.osso...........",
		"............osso.osso...........",
		"............oooo.oooo...........",
		"................................",
		"................................",
	],
	"work-blink": [
		"................................",
		"........o..............o........",
		".......oho............oho.......",
		"......oppho..........ohppo......",
		"......oppho..........ohppo......",
		".....ohhhhho........ohhhhho.....",
		"......oooooooooooooooooooo......",
		".....owwhhhhhhhhhhhhhhhhwwo.....",
		"....owwhhhhhhhhhhhhhhhhhhwwo....",
		"....ohhhsssssssssssssssshhho....",
		"....ohhsssssssssssssssssshho....",
		"....ohhsssssssssssssssssshho....",
		"....ohhsssooossssssooossshho....",
		"....ohhsssssssssssssssssshho....",
		"....ohhssbbssssssssssbbsshho....",
		"....ohhhsssssssmmssssssshhho....",
		".....ohhsssssssssssssssshho.....",
		".....ohooooooooooooooooooho..oo.",
		"....ohh..odoppprrpppodo..hhooHo.",
		"....ohh..ododpprrppdodo..hhoHHo.",
		"....oh...ododdddddddodo...hoHHo.",
		".........ododdddddddodo...oHHo..",
		".........ododdddddddodo..oHHo...",
		"...........oddddddddosooHHo.....",
		"...........oddddddddooHHo.......",
		"...........oDDDDDDDDooHo........",
		"...........oooooooooo...........",
		"............osso.osso...........",
		"............osso.osso...........",
		"............oooo.oooo...........",
		"................................",
		"................................",
	],
	happy: [
		"................................",
		"........o..............o........",
		".......oho............oho.......",
		"......oppho..........ohppo......",
		"......oppho..........ohppo......",
		".....ohhhhho........ohhhhho.....",
		"......oooooooooooooooooooo......",
		".....owwhhhhhhhhhhhhhhhhwwo.....",
		"....owwhhhhhhhhhhhhhhhhhhwwo....",
		"....ohhhsssssssssssssssshhho....",
		"....ohhsssssssssssssssssshho....",
		"....ohhssssossssssssosssshho....",
		"....ohhsssosossssssosossshho....",
		"....ohhsssssssssssssssssshho....",
		"....ohhssbbbssssssssbbbsshho....",
		"....ohhhssssssommosssssshhho....",
		".....ohhsssssssssssssssshho.....",
		".....ohooooooooooooooooooho..oo.",
		"....ohh..odoppprrpppodo..hhooHo.",
		"....ohh..ododpprrppdodo..hhoHHo.",
		"....oh...ododdddddddodo...hoHHo.",
		".........ododdddddddodo...oHHo..",
		".........ododdddddddodo..oHHo...",
		".........osoddddddddosooHHo.....",
		"...........oddddddddooHHo.......",
		"...........oDDDDDDDDooHo........",
		"...........oooooooooo...........",
		"............osso.osso...........",
		"............osso.osso...........",
		"............oooo.oooo...........",
		"................................",
		"................................",
	],
};

/** Paints `pose` onto a 32x32 canvas context (clears first). */
export function drawKimi(ctx: CanvasRenderingContext2D, pose: KimiPose): void {
	ctx.clearRect(0, 0, KIMI_SPRITE_SIZE, KIMI_SPRITE_SIZE);
	const rows = POSES[pose];
	for (let y = 0; y < KIMI_SPRITE_SIZE; y++) {
		const row = rows[y];
		for (let x = 0; x < KIMI_SPRITE_SIZE; x++) {
			const color = PALETTE[row[x]];
			if (!color) continue;
			ctx.fillStyle = color;
			ctx.fillRect(x, y, 1, 1);
		}
	}
}
