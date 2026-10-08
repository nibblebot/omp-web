#!/usr/bin/env bun
/**
 * Non-SDK dependency update plan for omp-web.
 *
 *   bun deps-plan.ts [--root <dir>]              JSON plan on stdout
 *   bun deps-plan.ts [--root <dir>] --sdk-lock   the bun.lock @oh-my-pi/* entries, sorted (diff before/after)
 *
 * The plan covers every direct `dependencies`/`devDependencies` entry except `@oh-my-pi/*`
 * (owned by the sdk-reconcile skill). For each package it reports the locked version, the
 * highest version the current spec allows (`inRange`), and the registry `latest` dist-tag.
 * `breaking: true` means `latest` falls outside the current spec (a semver-major, a 0.x minor,
 * or any change of an exact pin). `groups` lists packages that must move together:
 * `@types/<x>` with `<x>`, a shared npm scope, and `astro` with `@astrojs/*`.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SDK_PREFIX = "@oh-my-pi/";
const SECTIONS = ["dependencies", "devDependencies"] as const;
type Section = (typeof SECTIONS)[number];

interface Entry {
	name: string;
	section: Section;
	spec: string;
	installed: string | null;
	inRange: string | null;
	latest: string;
	breaking: boolean;
	deprecated: string | null;
	peerDependencies: Record<string, string> | null;
	/** Spec to write for the in-range update; null when already at the top of the range. */
	inRangeTarget: string | null;
	/** Spec to write for the out-of-range update to `latest`; null unless `breaking`. */
	breakingTarget: string | null;
}

interface Packument {
	"dist-tags": Record<string, string>;
	versions: Record<string, { deprecated?: string; peerDependencies?: Record<string, string> }>;
}

const args = process.argv.slice(2);
const rootIdx = args.indexOf("--root");
const root = resolve(rootIdx >= 0 ? (args[rootIdx + 1] ?? ".") : ".");
const lockText = readFileSync(join(root, "bun.lock"), "utf8");

if (args.includes("--sdk-lock")) {
	const lines = lockText
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.startsWith(`"${SDK_PREFIX}`))
		.sort();
	console.log(lines.join("\n"));
	process.exit(0);
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Partial<
	Record<Section, Record<string, string>>
>;

/** Version strictly newer than the floor (a missing floor counts as older than anything). */
function isNewer(version: string | null, floor: string | null): version is string {
	return version !== null && (floor === null || Bun.semver.order(version, floor) > 0);
}

async function planEntry(name: string, section: Section, spec: string): Promise<Entry> {
	const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}`, {
		headers: { accept: "application/vnd.npm.install-v1+json" },
	});
	if (!res.ok) throw new Error(`registry ${res.status} for ${name}`);
	const meta = (await res.json()) as Packument;
	const latest = meta["dist-tags"].latest;
	if (!latest) throw new Error(`no latest dist-tag for ${name}`);

	const prefix = spec.match(/^[\^~]?/)![0];
	const current = spec.slice(prefix.length);
	const exact = prefix === "";
	let inRange: string | null = exact ? current : null;
	if (!exact) {
		const allowPre = current.includes("-");
		for (const v of Object.keys(meta.versions)) {
			if ((allowPre || !v.includes("-")) && Bun.semver.satisfies(v, spec) && isNewer(v, inRange)) {
				inRange = v;
			}
		}
	}

	const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
	const locked = lockText.match(new RegExp(`^\\s{4}"${escaped}": \\["${escaped}@([^"]+)"`, "m"));
	const installed = locked?.[1] ?? null;
	const floor = installed ?? current;
	const breaking = exact ? isNewer(latest, current) : !Bun.semver.satisfies(latest, spec);
	return {
		name,
		section,
		spec,
		installed,
		inRange,
		latest,
		breaking,
		deprecated: meta.versions[latest]?.deprecated ?? null,
		peerDependencies: meta.versions[latest]?.peerDependencies ?? null,
		inRangeTarget: !exact && isNewer(inRange, floor) ? `${prefix}${inRange}` : null,
		breakingTarget: breaking && isNewer(latest, floor) ? `${prefix}${latest}` : null,
	};
}

const sdkExcluded: string[] = [];
const skipped: { name: string; spec: string; reason: string }[] = [];
const jobs: Promise<Entry>[] = [];
for (const section of SECTIONS) {
	for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
		if (name.startsWith(SDK_PREFIX)) sdkExcluded.push(name);
		else if (!/^[\^~]?\d/.test(spec))
			skipped.push({ name, spec, reason: "non-semver spec (tag, URL, workspace, or file)" });
		else jobs.push(planEntry(name, section, spec));
	}
}
const entries = await Promise.all(jobs);

const groups = new Map<string, string[]>();
for (const { name } of entries) {
	const base = name.startsWith("@types/") ? name.slice(7).replace(/^(.+)__(.+)$/, "@$1/$2") : name;
	const key =
		base === "astro" || base.startsWith("@astrojs/")
			? "astro"
			: base.startsWith("@")
				? base.split("/")[0]!
				: base;
	groups.set(key, [...(groups.get(key) ?? []), name]);
}

const inRangeCommands: string[] = [];
for (const section of SECTIONS) {
	const specs = entries
		.filter((e) => e.section === section && e.inRangeTarget !== null)
		.map((e) => `${e.name}@${e.inRangeTarget}`);
	if (specs.length > 0)
		inRangeCommands.push(`bun add${section === "devDependencies" ? " -d" : ""} ${specs.join(" ")}`);
}

const outdated = entries.filter((e) => e.inRangeTarget !== null || e.breakingTarget !== null);
console.log(
	JSON.stringify(
		{
			root,
			sdkExcluded,
			skipped,
			current: entries.filter((e) => !outdated.includes(e)).map((e) => `${e.name}@${e.installed}`),
			outdated,
			groups: [...groups.values()].filter((g) => g.length > 1),
			commands: {
				inRange: inRangeCommands,
				breaking: entries
					.filter((e) => e.breakingTarget !== null)
					.map(
						(e) =>
							`bun add${e.section === "devDependencies" ? " -d" : ""} ${e.name}@${e.breakingTarget}`,
					),
			},
		},
		null,
		"\t",
	),
);
