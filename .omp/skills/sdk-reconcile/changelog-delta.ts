#!/usr/bin/env bun
/**
 * Prints the upstream CHANGELOG sections between two @oh-my-pi versions for
 * every @oh-my-pi/* package pinned in package.json, read from the installed
 * node_modules copies (each package ships its CHANGELOG.md).
 *
 *   bun .omp/skills/sdk-reconcile/changelog-delta.ts --from 18.6.1 [--to 18.7.0] [--root .]
 *
 * --to defaults to the installed version of each package. Output is markdown:
 * one `# <package>` block per package, newest section first, with a leading
 * summary of the versions whose sections carry a "Breaking Changes" heading.
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

const from = arg("from");
if (from === undefined) {
	console.error("usage: changelog-delta.ts --from <version> [--to <version>] [--root <repo>]");
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

const breaking: string[] = [];
const blocks: string[] = [];
for (const name of names) {
	const dir = join(root, "node_modules", name);
	const version = manifestField(join(dir, "package.json"), "version");
	const installed = typeof version === "string" ? version : "unknown";
	const to = arg("to") ?? installed;
	const changelog = join(dir, "CHANGELOG.md");
	if (!existsSync(changelog)) {
		blocks.push(`# ${name} (installed ${installed})\n\nNo CHANGELOG.md in the installed package.`);
		continue;
	}
	// Split on "## [x.y.z]" headings; "## [Unreleased]" never matches the version pattern.
	const sections = readFileSync(changelog, "utf8").split(/^(?=## \[\d+\.\d+\.\d+\])/m);
	const picked = sections.filter((section) => {
		const version = /^## \[(\d+\.\d+\.\d+)\]/.exec(section)?.[1];
		return version !== undefined && compare(version, from) > 0 && compare(version, to) <= 0;
	});
	for (const section of picked) {
		if (/^### Breaking Changes/m.test(section)) {
			breaking.push(`${name}@${/^## \[([^\]]+)\]/.exec(section)?.[1]}`);
		}
	}
	blocks.push(
		`# ${name} (${from} → ${to}, installed ${installed})\n\n` +
			(picked.length > 0 ? picked.join("").trim() : "No sections in range."),
	);
}

console.log(
	`Breaking-change sections: ${breaking.length > 0 ? breaking.join(", ") : "none"}\n\n${blocks.join("\n\n")}`,
);
