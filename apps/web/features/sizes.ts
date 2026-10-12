import { FEATURE_IDS, type FeatureId } from "./manifest";

/** One emitted asset: file size and gzip (level 9) size in bytes. */
export interface ChunkSize {
	bytes: number;
	gzip: number;
}

/**
 * Build-emitted `feature-sizes.json` (version 1). Paths are relative to the
 * dist root. `features[id]` lists every asset reachable from that feature's
 * entry chunk but not from the app entry; a chunk shared by two features is
 * listed under both, so consumers must union before summing.
 */
export interface FeatureSizeManifest {
	version: 1;
	chunks: Record<string, ChunkSize>;
	core: string[];
	features: Partial<Record<FeatureId, string[]>>;
}

export type SizeTotals = ChunkSize;

function isChunkSize(value: unknown): value is ChunkSize {
	if (typeof value !== "object" || value === null) return false;
	const { bytes, gzip } = value as Partial<Record<"bytes" | "gzip", unknown>>;
	return (
		typeof bytes === "number" &&
		Number.isFinite(bytes) &&
		typeof gzip === "number" &&
		Number.isFinite(gzip)
	);
}

function isPathList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** Validate a decoded `feature-sizes.json`; null for any other shape or version. */
export function parseFeatureSizes(json: unknown): FeatureSizeManifest | null {
	if (typeof json !== "object" || json === null) return null;
	const raw = json as Partial<Record<"version" | "chunks" | "core" | "features", unknown>>;
	if (raw.version !== 1) return null;
	const { chunks, core, features } = raw;
	if (typeof chunks !== "object" || chunks === null) return null;
	if (!Object.values(chunks).every(isChunkSize)) return null;
	if (!isPathList(core)) return null;
	if (typeof features !== "object" || features === null) return null;
	const byFeature = features as Partial<Record<FeatureId, unknown>>;
	const parsedFeatures: FeatureSizeManifest["features"] = {};
	for (const id of FEATURE_IDS) {
		const paths = byFeature[id];
		if (paths === undefined) continue;
		if (!isPathList(paths)) return null;
		parsedFeatures[id] = paths;
	}
	return {
		version: 1,
		chunks: chunks as Record<string, ChunkSize>,
		core,
		features: parsedFeatures,
	};
}

function sumPaths(manifest: FeatureSizeManifest, paths: ReadonlySet<string>): SizeTotals {
	let bytes = 0;
	let gzip = 0;
	for (const path of paths) {
		const chunk = manifest.chunks[path];
		if (!chunk) continue;
		bytes += chunk.bytes;
		gzip += chunk.gzip;
	}
	return { bytes, gzip };
}

/**
 * Download size of core plus the given features. Chunks shared between
 * features (or listed twice) are counted once; ids absent from the build are
 * ignored; core is always included.
 */
export function featureSizeTotals(
	manifest: FeatureSizeManifest,
	ids: Iterable<FeatureId>,
): SizeTotals {
	const paths = new Set(manifest.core);
	for (const id of ids) {
		for (const path of manifest.features[id] ?? []) paths.add(path);
	}
	return sumPaths(manifest, paths);
}

/**
 * Size of one feature's own assets (including any chunk it shares with other
 * features), or null when the build does not contain the feature.
 */
export function featureOwnSize(manifest: FeatureSizeManifest, id: FeatureId): SizeTotals | null {
	const paths = manifest.features[id];
	return paths ? sumPaths(manifest, new Set(paths)) : null;
}

/** Kilobytes with one decimal (1 kB = 1000 B, the unit Vite's build report prints). */
export function formatKilobytes(bytes: number): string {
	return `${(bytes / 1000).toFixed(1)} kB`;
}

let cached: Promise<FeatureSizeManifest | null> | null = null;

async function fetchFeatureSizes(): Promise<FeatureSizeManifest | null> {
	try {
		const response = await fetch(`${import.meta.env.BASE_URL}feature-sizes.json`);
		if (!response.ok) return null;
		return parseFeatureSizes(await response.json());
	} catch {
		// Network failure or a non-JSON body (the dev server's HTML fallback).
		return null;
	}
}

/**
 * The build's size manifest, fetched once per page. Null when the page was
 * not served from a production build (dev HMR has no emitted chunks) or the
 * manifest is unreadable.
 */
export function loadFeatureSizes(): Promise<FeatureSizeManifest | null> {
	cached ??= fetchFeatureSizes();
	return cached;
}

/** Drop the cached manifest so the next load fetches again (design-system variants re-seed it). */
export function resetFeatureSizes(): void {
	cached = null;
}
