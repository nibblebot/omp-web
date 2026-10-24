#!/usr/bin/env bun
/**
 * Prints the upstream CHANGELOG sections between two @oh-my-pi versions for
 * every @oh-my-pi/* package pinned in package.json, read from the installed
 * node_modules copies (each package ships its CHANGELOG.md).
 *
 *   bun .omp/skills/sdk-reconcile/changelog-delta.ts --from 18.6.1 [--to 18.7.0] [--root .] [--json]
 *
 * --to defaults to the installed version of each package. Default output is
 * markdown: a `Breaking-change sections: ...` line (versions whose sections
 * carry a "Breaking Changes" heading), an `Entries: ...` line with per-category
 * entry counts across all packages, then one `# <package>` block per package,
 * newest section first.
 *
 * An entry is a top-level list item (`- ` or `* ` at column 0) plus its
 * indented continuation lines; its category is the `### <Heading>` it sits
 * under, normalized to breaking|removed|deprecated|changed|added|fixed|
 * security|other (entries before any `###` heading are `other`, heading "").
 *
 * --json prints one object instead:
 *   { from, packages: [{ name, installed, to, hasChangelog }],
 *     breakingSections: ["pkg@ver"], counts: { <category>: n },
 *     entries: [{ package, version, category, heading, text }] }
 * where `text` is the entry without its bullet marker, continuation lines
 * dedented and joined with "\n".
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function compare(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? undefined : process.argv[index + 1];
}

const CATEGORIES = [
	"breaking",
	"removed",
	"deprecated",
	"changed",
	"added",
	"fixed",
	"security",
	"other",
] as const;
type Category = (typeof CATEGORIES)[number];

interface Entry {
	package: string;
	version: string;
	category: Category;
	heading: string;
	text: string;
}

function categoryOf(heading: string): Category {
	switch (heading.trim().toLowerCase()) {
		case "breaking changes":
			return "breaking";
		case "removed":
			return "removed";
		case "deprecated":
			return "deprecated";
		case "changed":
			return "changed";
		case "added":
		case "features":
			return "added";
		case "fixed":
		case "bug fixes":
			return "fixed";
		case "security":
			return "security";
		default:
			return "other";
	}
}

/** Entry text: bullet marker stripped, continuation lines dedented by their common indent. */
function entryText(lines: string[]): string {
	const first = (lines[0] ?? "").replace(/^[-*] /, "");
	const rest = lines.slice(1);
	while (rest.length > 0 && rest[rest.length - 1]?.trim() === "") rest.pop();
	const indents = rest
		.filter((line) => line.trim() !== "")
		.map((line) => /^[ \t]*/.exec(line)?.[0].length ?? 0);
	const strip = indents.length > 0 ? Math.min(...indents) : 0;
	return [
		first.trimEnd(),
		...rest.map((line) => line.slice(Math.min(strip, line.length)).trimEnd()),
	].join("\n");
}

/** Splits one `## [x.y.z]` section into top-level list entries tagged with their `###` heading. */
function parseSection(pkg: string, version: string, section: string): Entry[] {
	const entries: Entry[] = [];
	let heading = "";
	let current: string[] | undefined;
	let fence = false;
	const flush = () => {
		if (current !== undefined) {
			entries.push({
				package: pkg,
				version,
				category: categoryOf(heading),
				heading,
				text: entryText(current),
			});
		}
		current = undefined;
	};
	// The first line is the `## [x.y.z]` heading itself.
	for (const line of section.split(/\r?\n/).slice(1)) {
		const isFence = /^\s*(```|~~~)/.test(line);
		if (isFence) fence = !fence;
		if (!fence && !isFence) {
			const h = /^###\s+(.*?)\s*#*\s*$/.exec(line);
			if (h !== null) {
				flush();
				heading = h[1] ?? "";
				continue;
			}
			if (/^[-*] /.test(line)) {
				flush();
				current = [line];
				continue;
			}
		}
		current?.push(line);
	}
	flush();
	return entries;
}

const from = arg("from");
if (from === undefined) {
	console.error(
		"usage: changelog-delta.ts --from <version> [--to <version>] [--root <repo>] [--json]",
	);
	process.exit(2);
}
/** One top-level field of a package.json file; undefined when absent. */
function manifestField(file: string, key: "dependencies" | "version"): unknown {
	const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
	return parsed !== null && typeof parsed === "object" ? Reflect.get(parsed, key) : undefined;
}

const root = arg("root") ?? process.cwd();
const dependencies = manifestField(join(root, "package.json"), "dependencies");
const names =
	dependencies !== null && typeof dependencies === "object"
		? Object.keys(dependencies).filter((name) => name.startsWith("@oh-my-pi/"))
		: [];

const json = process.argv.includes("--json");
const breaking: string[] = [];
const blocks: string[] = [];
const packages: { name: string; installed: string; to: string; hasChangelog: boolean }[] = [];
const entries: Entry[] = [];
for (const name of names) {
	const dir = join(root, "node_modules", name);
	const version = manifestField(join(dir, "package.json"), "version");
	const installed = typeof version === "string" ? version : "unknown";
	const to = arg("to") ?? installed;
	const changelog = join(dir, "CHANGELOG.md");
	if (!existsSync(changelog)) {
		packages.push({ name, installed, to, hasChangelog: false });
		blocks.push(`# ${name} (installed ${installed})\n\nNo CHANGELOG.md in the installed package.`);
		continue;
	}
	packages.push({ name, installed, to, hasChangelog: true });
	// Split on "## [x.y.z]" headings; "## [Unreleased]" never matches the version pattern.
	const sections = readFileSync(changelog, "utf8").split(/^(?=## \[\d+\.\d+\.\d+\])/m);
	const picked = sections.filter((section) => {
		const version = /^## \[(\d+\.\d+\.\d+)\]/.exec(section)?.[1];
		return version !== undefined && compare(version, from) > 0 && compare(version, to) <= 0;
	});
	for (const section of picked) {
		const sectionVersion = /^## \[([^\]]+)\]/.exec(section)?.[1] ?? "";
		if (/^### Breaking Changes/m.test(section)) breaking.push(`${name}@${sectionVersion}`);
		entries.push(...parseSection(name, sectionVersion, section));
	}
	blocks.push(
		`# ${name} (${from} → ${to}, installed ${installed})\n\n` +
			(picked.length > 0 ? picked.join("").trim() : "No sections in range."),
	);
}

const counts = Object.fromEntries(CATEGORIES.map((category) => [category, 0])) as Record<
	Category,
	number
>;
for (const entry of entries) counts[entry.category]++;

if (json) {
	console.log(
		JSON.stringify({ from, packages, breakingSections: breaking, counts, entries }, null, 2),
	);
} else {
	const summary = CATEGORIES.map((category) => `${category} ${counts[category]}`).join(", ");
	console.log(
		`Breaking-change sections: ${breaking.length > 0 ? breaking.join(", ") : "none"}\nEntries: ${summary}\n\n${blocks.join("\n\n")}`,
	);
}
