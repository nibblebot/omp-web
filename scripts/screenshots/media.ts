/**
 * ffmpeg plumbing: lossless stills, the animated hero, and the decoded-pixel
 * hash `--write` uses to tell a real change from encoder noise. ffmpeg is a
 * system binary, not a dependency; it must be built with libwebp.
 */

/** Frames per second of the hero animation. */
export const HERO_FPS = 25;

/** Hero files above this size draw a warning (GitHub shows them inline, so they load with the page). */
export const HERO_WARN_BYTES = 2_500_000;

async function ffmpeg(args: string[]): Promise<{ code: number; out: string; err: string }> {
	const proc = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, out, err };
}

/** True when an `ffmpeg -decoders` listing has the animated WebP decoder (`webp_anim`, new in FFmpeg 9.0; older builds decode only still WebP). */
export function listsAnimatedWebpDecoder(decoders: string): boolean {
	return /\swebp_anim\s/.test(decoders);
}

async function ffmpegListing(flag: "-encoders" | "-decoders"): Promise<string> {
	const proc = Bun.spawn(["ffmpeg", "-hide_banner", flag], { stdout: "pipe", stderr: "ignore" });
	const [listing] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	return listing;
}

/**
 * Fail early, with the fix, when ffmpeg is missing or cannot write WebP. `needAnimation`: the
 * videos are rendered (animated WebP). `needDecode`: `--write` will compare those videos with the
 * committed ones by decoding animated WebP, which takes ffmpeg 9.0 or newer; an older one would fail
 * (or compare wrongly) in the middle of the sync, after some files were already copied.
 */
export async function requireFfmpeg(needAnimation: boolean, needDecode: boolean): Promise<void> {
	if (Bun.which("ffmpeg") === null) {
		throw new Error(
			"ffmpeg not found on PATH. Install ffmpeg with libwebp support (the screenshots are encoded as WebP with it).",
		);
	}
	const encoders = await ffmpegListing("-encoders");
	const missing = ["libwebp", ...(needAnimation ? ["libwebp_anim"] : [])].filter(
		(name) => !new RegExp(`\\s${name}\\s`).test(encoders),
	);
	if (missing.length > 0) {
		throw new Error(
			`this ffmpeg lacks the ${missing.join(" and ")} encoder${missing.length > 1 ? "s" : ""}; install a build with libwebp${needAnimation ? " (or rerun with --no-hero)" : ""}.`,
		);
	}
	if (needDecode && !listsAnimatedWebpDecoder(await ffmpegListing("-decoders"))) {
		throw new Error(
			"--write compares the animated hero videos by decoding them, and this ffmpeg cannot decode animated WebP (needs ffmpeg 9.0 or newer). Upgrade ffmpeg, or rerun without --write or with --no-hero.",
		);
	}
}

/** Lossless WebP of one PNG. */
export async function pngToWebp(png: string, webp: string): Promise<void> {
	const { code, err } = await ffmpeg(["-y", "-i", png, "-c:v", "libwebp", "-lossless", "1", webp]);
	if (code !== 0) throw new Error(`ffmpeg failed encoding ${webp}: ${err.trim()}`);
}

/** Looping animated WebP of `dir/f%03d.png` frames, scaled to `width` pixels wide (Lanczos) when given. */
export async function framesToWebp(
	dir: string,
	webp: string,
	options: { width?: number } = {},
): Promise<void> {
	const { code, err } = await ffmpeg([
		"-y",
		"-framerate",
		String(HERO_FPS),
		"-i",
		`${dir}/f%03d.png`,
		...(options.width === undefined ? [] : ["-vf", `scale=${options.width}:-2:flags=lanczos`]),
		"-c:v",
		"libwebp_anim",
		"-quality",
		"90",
		"-loop",
		"0",
		webp,
	]);
	if (code !== 0) throw new Error(`ffmpeg failed encoding ${webp}: ${err.trim()}`);
}

/**
 * SHA-256 over the decoded RGBA frames of an image (every frame of an animated
 * one). Two files with equal hashes show identical pixels however they were encoded.
 */
export async function decodedHash(path: string): Promise<string> {
	const { code, out, err } = await ffmpeg([
		"-i",
		path,
		"-map",
		"0:v",
		"-c:v",
		"rawvideo",
		"-pix_fmt",
		"rgba",
		"-f",
		"hash",
		"-hash",
		"sha256",
		"-",
	]);
	const match = /SHA256=([0-9a-f]{64})/.exec(out);
	if (code !== 0 || match === null)
		throw new Error(`ffmpeg failed decoding ${path}: ${err.trim()}`);
	return match[1]!;
}
