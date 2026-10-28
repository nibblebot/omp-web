import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import type { Plugin } from "vite";

/** Extensions worth compressing; images and fonts are already compressed. */
const COMPRESSIBLE = /\.(?:js|css|html|svg|json|webmanifest|txt)$/;

/** Below this size the encoding header costs more than it saves. */
const MIN_BYTES = 1024;

function walk(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
	);
}

/**
 * Build-only plugin: writes `<file>.br` and `<file>.gz` next to every
 * compressible file in the output directory, keeping an encoding only when it
 * is smaller than the original. The fleet's static server (`static-ui.ts`)
 * picks one by `Accept-Encoding`; the installable bundle embeds them like any
 * other dist file. Runs in `closeBundle`, after `feature-sizes.json` is written.
 */
export function precompress(): Plugin {
	let outDir = "";
	return {
		name: "omp-precompress",
		apply: "build",
		configResolved(config) {
			outDir = resolve(config.root, config.build.outDir);
		},
		closeBundle() {
			for (const file of walk(outDir)) {
				if (!COMPRESSIBLE.test(file)) continue;
				const body = readFileSync(file);
				if (body.byteLength < MIN_BYTES) continue;
				const encodings = [
					[
						".br",
						brotliCompressSync(body, {
							params: {
								[constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
								[constants.BROTLI_PARAM_SIZE_HINT]: body.byteLength,
							},
						}),
					],
					[".gz", gzipSync(body, { level: 9 })],
				] as const;
				for (const [suffix, compressed] of encodings) {
					if (compressed.byteLength < body.byteLength) writeFileSync(file + suffix, compressed);
				}
			}
		},
	};
}
