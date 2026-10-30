/** Command line parsing and `--help` text for `bun run screenshots`. */
import { SCHEMES, SHOTS, type Scheme, type Shot } from "./scenes";

/** Every selectable shot id, in contact-sheet order. */
export const SHOT_IDS: readonly string[] = SHOTS.map((shot) => shot.id);

export const USAGE = `bun run screenshots: render the README screenshots from the design-system demo

Builds the static demo (bun run build:demo), serves it on a loopback port and
drives it with Playwright's Chromium under a fixed clock, zone, locale and
reduced motion, so a second run produces identical pixels. Every shot is
rendered in the light and dark scheme into .screenshots-out/ (gitignored) with
an index.html contact sheet. Manual only: nothing in CI runs it.

Requires:
  ffmpeg with libwebp (system binary): stills are lossless WebP, videos animated WebP;
    --write needs ffmpeg 9.0 or newer (first to decode animated WebP, to compare the videos)
  a Playwright Chromium: bunx playwright install chromium-headless-shell
    (a system Chromium, or PROFILE_CHROMIUM=<path>, is used when the cache has none)

Usage: bun run screenshots [options]
  --only <sel,...>  render just these shots (repeatable or comma separated). A selector is a
                    shot id (both schemes) or an output stem such as hero-dark or
                    tool-read-light (that scheme only)
  --scheme <s,...>  render only these schemes: light, dark (repeatable or comma separated;
                    default both); narrows --only too
  --list            print every shot id with its kind (still, video, svg) and what it shows
  --no-hero         skip the videos (hero and hero-phone: the slow part; needs no
                    animated-WebP ffmpeg)
  --write           then copy what was rendered into docs/screenshots/: only files whose
                    decoded pixels changed. A full run also deletes files there that are no
                    longer produced; any selection (--only, --scheme, --no-hero) never deletes
  --help

Examples:
  bun run screenshots --only hero-phone          one video, both schemes
  bun run screenshots --only hero-dark           one file
  bun run screenshots --only tool-read --scheme light

Run --list for the shot ids.
`;

export interface Options {
	/**
	 * The schemes each selected shot id is rendered in; empty means every shot. An id selected by its
	 * bare name has both schemes (before `--scheme` narrows them), by an output stem just that one.
	 */
	only: ReadonlyMap<string, readonly Scheme[]>;
	/** `--scheme`: the schemes to render (every scheme when absent). */
	schemes: readonly Scheme[];
	hero: boolean;
	write: boolean;
	list: boolean;
	help: boolean;
}

export class UsageError extends Error {}

/** The schemes a shot is rendered in under `options` (empty: not selected). */
export function schemesFor(options: Options, id: string): Scheme[] {
	const wanted = options.only.size === 0 ? SCHEMES : options.only.get(id);
	return (wanted ?? []).filter((scheme) => options.schemes.includes(scheme));
}

/** A selection narrower than the whole scene list: it knows nothing about files outside it. */
export function isPartial(options: Options): boolean {
	return options.only.size > 0 || options.schemes.length < SCHEMES.length || !options.hero;
}

/** `hero-dark`: the shot id and scheme an output stem names. */
function parseStem(text: string): { id: string; scheme: Scheme } | undefined {
	for (const scheme of SCHEMES) {
		const id = text.endsWith(`-${scheme}`) ? text.slice(0, -scheme.length - 1) : undefined;
		if (id !== undefined && SHOT_IDS.includes(id)) return { id, scheme };
	}
	return undefined;
}

function parseScheme(text: string): Scheme {
	const scheme = SCHEMES.find((candidate) => candidate === text);
	if (scheme === undefined) throw new UsageError(`unknown scheme: ${text} (light or dark)`);
	return scheme;
}

/** The value of `--name value` or `--name=value`; advances `i` past a separate value. */
function optionValue(argv: readonly string[], i: number, name: string): [value: string, i: number] {
	const arg = argv[i]!;
	const value = arg === name ? argv[i + 1] : arg.slice(name.length + 1);
	if (value === undefined || value === "") throw new UsageError(`${name} needs a value`);
	return [value, arg === name ? i + 1 : i];
}

export function parseArgs(argv: readonly string[]): Options {
	const only = new Map<string, Set<Scheme>>();
	const schemes = new Set<Scheme>();
	let hero = true;
	let write = false;
	let list = false;
	let help = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--help" || arg === "-h") help = true;
		else if (arg === "--no-hero") hero = false;
		else if (arg === "--write") write = true;
		else if (arg === "--list") list = true;
		else if (arg === "--only" || arg.startsWith("--only=")) {
			const [value, last] = optionValue(argv, i, "--only");
			i = last;
			for (const selector of value.split(",")) {
				const stem = SHOT_IDS.includes(selector) ? undefined : parseStem(selector);
				if (stem === undefined && !SHOT_IDS.includes(selector))
					throw new UsageError(`unknown shot id: ${selector}`);
				const found = only.get(stem?.id ?? selector) ?? new Set<Scheme>();
				for (const scheme of stem === undefined ? SCHEMES : [stem.scheme]) found.add(scheme);
				only.set(stem?.id ?? selector, found);
			}
		} else if (arg === "--scheme" || arg.startsWith("--scheme=")) {
			const [value, last] = optionValue(argv, i, "--scheme");
			i = last;
			for (const name of value.split(",")) schemes.add(parseScheme(name));
		} else throw new UsageError(`unknown argument: ${arg}`);
	}
	const options: Options = {
		only: new Map([...only].map(([id, set]) => [id, SCHEMES.filter((s) => set.has(s))])),
		schemes: schemes.size === 0 ? SCHEMES : SCHEMES.filter((scheme) => schemes.has(scheme)),
		hero,
		write,
		list,
		help,
	};
	for (const id of options.only.keys()) {
		if (schemesFor(options, id).length === 0)
			throw new UsageError(`--only ${id} and --scheme ${options.schemes.join(",")} select nothing`);
	}
	return options;
}

/** One line per shot for `--list`: id, kind, what it shows. */
export function listShots(shots: readonly Shot[] = SHOTS): string {
	const width = Math.max(...shots.map((shot) => shot.id.length));
	return shots
		.map((shot) => `${shot.id.padEnd(width)}  ${shot.kind.padEnd(5)}  ${shot.shows}`)
		.join("\n");
}
