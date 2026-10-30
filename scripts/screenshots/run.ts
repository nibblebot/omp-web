/** The `bun run screenshots` pipeline: build, serve, render every selected shot, sheet, optional sync. */
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_THEMES } from "#lib/themes/builtin";
import { isPartial, schemesFor, type Options } from "./args";
import {
	architecturePaletteFromTheme,
	renderArchitectureSvg,
	renderSplitArchitectureSvg,
	type ArchitecturePalette,
} from "./architecture-svg";
import { renderDevicesSvg } from "./devices-svg";
import { startEnv, type Env } from "./browser";
import { captureStill } from "./capture";
import { writeContactSheet } from "./contact-sheet";
import { captureHero } from "./hero";
import { capturePhoneHero, PHONE_OUTPUT_WIDTH } from "./hero-phone";
import { framesToWebp, HERO_WARN_BYTES, pngToWebp, requireFfmpeg } from "./media";
import {
	ARCHITECTURE_ID,
	ARCHITECTURE_SPLIT_ID,
	DEVICES_ID,
	HERO_ID,
	HERO_PHONE_ID,
	outputFiles,
	SHOTS,
	STILLS,
	THEMES_GRID_ID,
	type Scheme,
} from "./scenes";
import { sameContent, syncOutput } from "./sync";
import { captureThemesGrid } from "./themes-grid";

/** Concurrent browser contexts; each shot has its own, so this only bounds CPU use. */
const CONCURRENCY = 4;

/** One output file and the work that renders it. */
interface Job {
	file: string;
	run(): Promise<void>;
}

async function pool(jobs: readonly Job[], limit: number): Promise<void> {
	const queue = [...jobs];
	const failures: string[] = [];
	const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
		for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
			try {
				await job.run();
			} catch (err) {
				const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
				failures.push(`${job.file}: ${message}`);
			}
		}
	});
	await Promise.all(runners);
	if (failures.length > 0) throw new Error(failures.sort().join("\n"));
}

function kib(bytes: number): string {
	return `${(bytes / 1024).toFixed(1)} KiB`;
}

/** How a video shot is made: `record` writes `dir/f001.png ...` and returns the frame count; `width` scales the encode. */
interface Video {
	record: (env: Env, scheme: Scheme, dir: string) => Promise<number>;
	width?: number;
}

const VIDEOS: Readonly<Record<string, Video>> = {
	[HERO_ID]: { record: captureHero },
	[HERO_PHONE_ID]: { record: capturePhoneHero, width: PHONE_OUTPUT_WIDTH },
};

/** Build the render jobs for the selected shots and schemes. */
function plan(options: Options, env: Env, outDir: string, scratch: string): Job[] {
	const jobs: Job[] = [];
	const still = async (file: string, render: (png: string) => Promise<void>): Promise<void> => {
		const png = join(scratch, `${file}.png`);
		await render(png);
		await pngToWebp(png, join(outDir, file));
	};
	for (const shot of SHOTS) {
		for (const scheme of schemesFor(options, shot.id)) {
			const file = `${shot.id}-${scheme}.${shot.ext}`;
			if (shot.kind === "svg") jobs.push(diagramJob(shot.id, scheme, outDir));
			else if (shot.kind === "video") {
				if (!options.hero) continue;
				const video = VIDEOS[shot.id];
				if (video === undefined) throw new Error(`no recorder for ${shot.id}`);
				jobs.push({
					file,
					run: async () => {
						const dir = join(scratch, `${shot.id}-${scheme}`);
						await video.record(env, scheme, dir);
						await framesToWebp(dir, join(outDir, file), { width: video.width });
					},
				});
			} else if (shot.id === THEMES_GRID_ID) {
				jobs.push({ file, run: () => still(file, (png) => captureThemesGrid(env, scheme, png)) });
			} else {
				const scene = STILLS.find((candidate) => candidate.id === shot.id);
				if (scene === undefined) throw new Error(`no still scene for ${shot.id}`);
				jobs.push({ file, run: () => still(file, (png) => captureStill(env, scene, scheme, png)) });
			}
		}
	}
	return jobs;
}

/** The diagrams, by shot id. */
const DIAGRAMS: Readonly<Record<string, (palette: ArchitecturePalette) => string>> = {
	[ARCHITECTURE_ID]: renderArchitectureSvg,
	[ARCHITECTURE_SPLIT_ID]: renderSplitArchitectureSvg,
	[DEVICES_ID]: renderDevicesSvg,
};

/** A generated diagram, colored from the Catppuccin variant of the scheme. */
function diagramJob(id: string, scheme: Scheme, outDir: string): Job {
	const render = DIAGRAMS[id];
	if (render === undefined) throw new Error(`no diagram for ${id}`);
	const file = `${id}-${scheme}.svg`;
	return {
		file,
		run: async () => {
			const theme = BUILTIN_THEMES.find((entry) => entry.id === "catppuccin");
			const variant = theme?.variants[scheme];
			if (variant === undefined) throw new Error(`no Catppuccin ${scheme} variant`);
			writeFileSync(join(outDir, file), render(architecturePaletteFromTheme(variant)));
		},
	};
}

export async function runScreenshots(options: Options, repoRoot: string): Promise<void> {
	const outDir = join(repoRoot, ".screenshots-out");
	const partial = isPartial(options);
	const scratch = mkdtempSync(join(tmpdir(), "omp-web-screenshots-"));
	let env: Env | undefined;
	try {
		const videoFiles = new Set(
			SHOTS.filter((shot) => shot.kind === "video").flatMap((shot) =>
				schemesFor(options, shot.id).map((scheme) => `${shot.id}-${scheme}.${shot.ext}`),
			),
		);
		const rendersVideos = options.hero && videoFiles.size > 0;
		await requireFfmpeg(rendersVideos, options.write && rendersVideos);
		if (!partial) rmSync(outDir, { recursive: true, force: true });
		mkdirSync(outDir, { recursive: true });
		env = await startEnv(repoRoot, join(scratch, "demo"));
		const jobs = plan(options, env, outDir, scratch);
		if (jobs.length === 0) throw new Error("nothing selected (--only with --no-hero?)");
		const started = performance.now();
		await pool(jobs, CONCURRENCY);
		writeContactSheet(outDir);

		let total = 0;
		for (const job of jobs.sort((a, b) => a.file.localeCompare(b.file))) {
			const size = statSync(join(outDir, job.file)).size;
			total += size;
			const warn =
				videoFiles.has(job.file) && size > HERO_WARN_BYTES
					? `  WARNING: over ${HERO_WARN_BYTES / 1e6} MB`
					: "";
			console.log(`${job.file.padEnd(36)} ${kib(size).padStart(11)}${warn}`);
		}
		console.log(
			`${jobs.length} files, ${kib(total)} total, ${((performance.now() - started) / 1000).toFixed(1)} s; contact sheet: .screenshots-out/index.html`,
		);

		if (options.write) {
			const target = join(repoRoot, "docs/screenshots");
			const rendered = jobs.map((job) => job.file);
			const result = await syncOutput(outDir, target, {
				files: rendered,
				// Only a full run knows every file the scene list owns, so only it prunes.
				keep: partial ? undefined : outputFiles(),
				same: sameContent,
			});
			console.log(
				`docs/screenshots: ${result.copied.length} written, ${result.unchanged.length} unchanged, ${result.removed.length} removed`,
			);
			for (const name of result.copied) console.log(`  + ${name}`);
			for (const name of result.removed) console.log(`  - ${name}`);
		}
	} finally {
		await env?.stop();
		rmSync(scratch, { recursive: true, force: true });
	}
}
