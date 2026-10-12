import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import type { Plugin, Rollup } from "vite";
import type { FeatureId } from "../features/manifest";
import { FEATURE_IDS, isFeatureId } from "../features/manifest";

/** File name of the emitted size manifest, relative to the dist root. */
export const FEATURE_SIZES_FILE = "feature-sizes.json";

export interface ChunkSize {
	/** Emitted file size in bytes. */
	bytes: number;
	/** Gzip (level 9) size in bytes. */
	gzip: number;
}

export interface FeatureSizeManifest {
	version: 1;
	chunks: Record<string, ChunkSize>;
	/** Every JS/CSS asset not owned by a feature: the app entry closure plus anything else emitted. */
	core: string[];
	/** Per feature: every asset its entry needs that the app entry does not statically load. */
	features: Partial<Record<FeatureId, string[]>>;
}

const DEFAULT_FEATURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "features");

const FEATURE_ENTRY = /^(?<id>[^./\\]+)\.tsx?$/;

/** The feature whose entry module (`<featuresDir>/<id>.ts|tsx`) is `moduleId`, if any. */
function featureOfEntry(moduleId: string | null, featuresDir: string): FeatureId | undefined {
	if (moduleId === null) return undefined;
	const path = moduleId.split("?")[0]?.split("\\").join("/") ?? "";
	if (dirname(path) !== featuresDir.split("\\").join("/")) return undefined;
	const id = FEATURE_ENTRY.exec(basename(path))?.groups?.id;
	return id !== undefined && isFeatureId(id) ? id : undefined;
}

/** Walk the chunk graph from `roots` over static imports, imported CSS, and (optionally) dynamic imports, never entering `stop`. */
function reach(
	bundle: Rollup.OutputBundle,
	roots: readonly string[],
	stop: ReadonlySet<string>,
	followDynamic: boolean,
): Set<string> {
	const seen = new Set<string>();
	const stack = [...roots];
	for (let file = stack.pop(); file !== undefined; file = stack.pop()) {
		const output = bundle[file];
		if (seen.has(file) || stop.has(file) || output === undefined) continue;
		seen.add(file);
		if (output.type !== "chunk") continue;
		stack.push(...output.imports, ...(output.viteMetadata?.importedCss ?? []));
		if (followDynamic) stack.push(...output.dynamicImports);
	}
	return seen;
}

/**
 * Classify every emitted JS/CSS asset as core or feature-owned.
 *
 * `sizeOf` measures a file by its name in the final output directory. The app
 * entry's static closure (JS and CSS) is core. A feature's entry owns every
 * asset it reaches over static imports, imported CSS, and dynamic imports,
 * except anything in the entry's static closure: that is already downloaded
 * whenever the app loads, so the feature never needs it and does not walk
 * through it. An asset shared by two features appears in both lists.
 */
export function classifyBundle(
	bundle: Rollup.OutputBundle,
	sizeOf: (fileName: string) => ChunkSize,
	featuresDir: string = DEFAULT_FEATURES_DIR,
): FeatureSizeManifest {
	const shipped = Object.keys(bundle).filter(
		(file) => file.endsWith(".js") || file.endsWith(".css"),
	);
	const chunks = Object.fromEntries(shipped.sort().map((file) => [file, sizeOf(file)] as const));

	const entries = Object.values(bundle).flatMap((o) =>
		o.type === "chunk" && o.isEntry ? [o.fileName] : [],
	);
	const entryStatic = reach(bundle, entries, new Set(), false);

	const featureAssets = new Map<FeatureId, Set<string>>();
	for (const output of Object.values(bundle)) {
		if (output.type !== "chunk") continue;
		const id = featureOfEntry(output.facadeModuleId, featuresDir);
		if (id === undefined) continue;
		const owned = featureAssets.get(id) ?? new Set<string>();
		for (const file of reach(bundle, [output.fileName], entryStatic, true)) owned.add(file);
		featureAssets.set(id, owned);
	}

	const features: FeatureSizeManifest["features"] = {};
	const claimed = new Set<string>();
	for (const id of FEATURE_IDS) {
		const owned = featureAssets.get(id);
		if (owned === undefined) continue;
		features[id] = [...owned].filter((file) => file in chunks).sort();
		for (const file of owned) claimed.add(file);
	}

	return {
		version: 1,
		chunks,
		core: shipped.filter((file) => !claimed.has(file)).sort(),
		features,
	};
}

function measure(body: Uint8Array): ChunkSize {
	return { bytes: body.byteLength, gzip: gzipSync(body, { level: 9 }).byteLength };
}

/**
 * Build-only plugin: writes `feature-sizes.json` (see {@link FeatureSizeManifest})
 * into the output directory so Settings > Features can show the download cost
 * of each lazy feature chunk. It runs in `writeBundle`, after every other
 * plugin has finished rewriting chunk code (CSS placeholders, asset URLs), so
 * the sizes are those of the files actually on disk.
 */
export function featureSizes(options: { featuresDir?: string } = {}): Plugin {
	return {
		name: "omp-feature-sizes",
		apply: "build",
		writeBundle(outputOptions, bundle) {
			const dir = outputOptions.dir;
			if (dir === undefined) throw new Error("featureSizes requires an output directory");
			const manifest = classifyBundle(
				bundle,
				(file) => measure(readFileSync(join(dir, file))),
				options.featuresDir,
			);
			writeFileSync(join(dir, FEATURE_SIZES_FILE), `${JSON.stringify(manifest, null, "\t")}\n`);
		},
	};
}
