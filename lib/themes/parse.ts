/**
 * Validate, migrate and resolve one theme file. Collects every schema error
 * (path-prefixed, e.g. `variants.dark.accent: not a color ...`). Contrast findings are
 * never errors; `contrastWarnings` (contrast.ts) reports them on demand.
 */
import { isRecord } from "#lib/wire/type-guards";
import { isColor } from "./color";
import { resolveVariant } from "./derive";
import {
	THEME_CORE_TOKENS,
	THEME_OPTIONAL_TOKENS,
	THEME_SCHEMA_VERSION,
	THEME_SCHEMES,
	THEME_STEM_PATTERN,
} from "./types";
import type {
	ThemeEntry,
	ThemeParseResult,
	ThemeScheme,
	ThemeSource,
	ThemeVariant,
	ThemeVariantInput,
} from "./types";

type Document = Record<string, unknown>;

/**
 * Migration steps keyed by the version they upgrade FROM: `MIGRATIONS[n]` turns a
 * version-n document into a version-(n+1) document. Only version 1 exists, so the
 * table is empty; add `1: (doc) => ...` when version 2 is introduced.
 */
const MIGRATIONS: Readonly<Record<number, (doc: Document) => Document>> = {};

const TOP_LEVEL_KEYS: Readonly<Record<string, true>> = {
	$schema: true,
	schemaVersion: true,
	name: true,
	variants: true,
};
const KNOWN_TOKENS: Readonly<Record<string, true>> = Object.fromEntries(
	[...THEME_CORE_TOKENS, ...THEME_OPTIONAL_TOKENS].map((token) => [token, true]),
);
const COLOR_FORMATS = "#rgb, #rrggbb, #rrggbbaa or oklch(L% C h [/ a])";

function describe(value: unknown): string {
	return JSON.stringify(value) ?? String(value);
}

function migrate(doc: Document, from: number, errors: string[]): Document {
	let current = doc;
	for (let version = from; version < THEME_SCHEMA_VERSION; version++) {
		const step = MIGRATIONS[version];
		if (!step) {
			errors.push(`schemaVersion: no migration from version ${version}`);
			return current;
		}
		current = { ...step(current), schemaVersion: version + 1 };
	}
	return current;
}

function validateVariant(path: string, value: unknown, errors: string[]): ThemeVariantInput | null {
	if (!isRecord(value)) {
		errors.push(`${path}: expected an object of color tokens`);
		return null;
	}
	const before = errors.length;
	for (const token of THEME_CORE_TOKENS) {
		if (!Object.hasOwn(value, token)) errors.push(`${path}.${token}: missing required token`);
	}
	for (const [token, color] of Object.entries(value)) {
		if (!Object.hasOwn(KNOWN_TOKENS, token)) {
			errors.push(`${path}.${token}: unknown token`);
		} else if (!isColor(color)) {
			errors.push(
				`${path}.${token}: not a color (expected ${COLOR_FORMATS}, got ${describe(color)})`,
			);
		}
	}
	return errors.length === before ? (value as ThemeVariantInput) : null;
}

/** Validate a parsed JSON document for theme `stem`, migrate it to the current schema, and resolve every variant. */
export function parseThemeFile(stem: string, raw: unknown, source: ThemeSource): ThemeParseResult {
	const errors: string[] = [];
	if (!THEME_STEM_PATTERN.test(stem)) {
		errors.push(
			`file name: "${stem}" must match ${THEME_STEM_PATTERN.source} (lowercase letters, digits and dashes)`,
		);
	}
	if (!isRecord(raw)) {
		errors.push("file: expected a JSON object");
		return { ok: false, errors };
	}

	const version = raw["schemaVersion"];
	let doc: Document = raw;
	if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
		errors.push(
			`schemaVersion: required integer >= 1 (current is ${THEME_SCHEMA_VERSION}, got ${describe(version)})`,
		);
	} else if (version > THEME_SCHEMA_VERSION) {
		errors.push(
			`schemaVersion: ${version} is newer than this omp-web supports (${THEME_SCHEMA_VERSION}); update omp-web or lower the version`,
		);
		return { ok: false, errors };
	} else {
		doc = migrate(raw, version, errors);
	}

	for (const key of Object.keys(doc)) {
		if (!Object.hasOwn(TOP_LEVEL_KEYS, key)) errors.push(`${key}: unknown key`);
	}
	if (doc["$schema"] !== undefined && typeof doc["$schema"] !== "string") {
		errors.push("$schema: expected a string");
	}
	const name = doc["name"];
	if (typeof name !== "string" || name.trim() === "")
		errors.push("name: required non-empty string");

	const variants: Partial<Record<ThemeScheme, ThemeVariant>> = {};
	const rawVariants = doc["variants"];
	if (!isRecord(rawVariants)) {
		errors.push("variants: required object with at least one of dark, light");
	} else {
		for (const key of Object.keys(rawVariants)) {
			if (!THEME_SCHEMES.includes(key as ThemeScheme)) {
				errors.push(`variants.${key}: unknown variant (expected dark or light)`);
			}
		}
		if (!THEME_SCHEMES.some((scheme) => Object.hasOwn(rawVariants, scheme))) {
			errors.push("variants: must define at least one of dark, light");
		}
		for (const scheme of THEME_SCHEMES) {
			if (!Object.hasOwn(rawVariants, scheme)) continue;
			const input = validateVariant(`variants.${scheme}`, rawVariants[scheme], errors);
			if (input) variants[scheme] = resolveVariant(scheme, input);
		}
	}

	if (errors.length > 0) return { ok: false, errors };
	const entry: ThemeEntry = { id: stem, name: (name as string).trim(), source, variants };
	return { ok: true, entry };
}
