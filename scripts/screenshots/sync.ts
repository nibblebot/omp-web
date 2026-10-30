/**
 * `--write`: make `docs/screenshots/` match the output directory without churn.
 * A file is copied only when its decoded pixels differ from the one already
 * there (a re-encode of identical pixels is not a change), and files that the
 * scene list no longer produces are deleted.
 */
import { copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { decodedHash } from "./media";

/** `true` when the two files show the same thing. */
export type SameContent = (a: string, b: string) => Promise<boolean>;

/** Same decoded pixels (WebP, every frame of an animation) or same bytes (SVG). */
export async function sameContent(a: string, b: string): Promise<boolean> {
	if (a.endsWith(".svg")) {
		const [left, right] = await Promise.all([readFile(a), readFile(b)]);
		return left.equals(right);
	}
	const [left, right] = await Promise.all([decodedHash(a), decodedHash(b)]);
	return left === right;
}

export interface SyncOptions {
	/** File names rendered in the output directory to bring over. */
	files: readonly string[];
	/** When set, every other entry of the target directory is deleted (a full run knows all the scene list owns). */
	keep?: readonly string[];
	same: SameContent;
}

export interface SyncResult {
	/** New or changed files copied in. */
	copied: string[];
	/** Present and pixel-identical: left alone. */
	unchanged: string[];
	/** Entries of the target directory the scene list no longer produces, deleted. */
	removed: string[];
}

/** Bring `options.files` from `outDir` into `targetDir`, touching only what changed. */
export async function syncOutput(
	outDir: string,
	targetDir: string,
	options: SyncOptions,
): Promise<SyncResult> {
	await mkdir(targetDir, { recursive: true });
	const there = new Set(await readdir(targetDir));
	const result: SyncResult = { copied: [], unchanged: [], removed: [] };
	for (const name of [...options.files].sort()) {
		const from = join(outDir, name);
		const to = join(targetDir, name);
		if (there.has(name) && (await options.same(from, to))) {
			result.unchanged.push(name);
			continue;
		}
		await copyFile(from, to);
		result.copied.push(name);
	}
	if (options.keep !== undefined) {
		const wanted = new Set(options.keep);
		for (const name of [...there].sort()) {
			if (wanted.has(name)) continue;
			await rm(join(targetDir, name), { recursive: true, force: true });
			result.removed.push(name);
		}
	}
	return result;
}
