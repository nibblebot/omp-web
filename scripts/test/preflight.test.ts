/**
 * Preflight tests: the pure checks, the argument surface, and one wired
 * runChecks pass over a scratch repository. No network, no git and no gh: the
 * command runner is a fake and every fixture lives in a tempDir() scratch dir.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../lib/testkit/temp-dir.testkit";
import {
	CHECKBOX_SKIPPED,
	checkGateList,
	checkSdkPins,
	compareSemver,
	exitCode,
	formatReport,
	parsePreflightArgs,
	runChecks,
	scanCheckboxes,
	scanRelativeLinks,
	scanSdkLiterals,
	sdkPins,
	summarize,
	uniformPin,
	versionsNewerThan,
} from "../preflight";
import type { CommandResult, CommandRunner, DocsFile, Finding, SdkPin } from "../preflight";

afterAll(cleanupTempDirs);

const file = (path: string, content: string): DocsFile => ({ path, content });

const pins = (...versions: string[]): SdkPin[] =>
	versions.map((pin, index) => ({ name: `@oh-my-pi/pi-${index}`, pin }));

const upstream = (latest: string): { ok: true; latest: string; versions: string[] } => ({
	ok: true,
	latest,
	versions: ["18.1.0", "18.2.6", "18.2.7", latest],
});

const messages = (findings: Finding[]): string =>
	findings.map((finding) => finding.message).join("\n");

describe("compareSemver", () => {
	test("orders numeric segments and pads missing ones", () => {
		expect(compareSemver("0.2.0", "0.1.0")).toBeGreaterThan(0);
		expect(compareSemver("0.1.0", "0.2.0")).toBeLessThan(0);
		expect(compareSemver("0.10.0", "0.9.0")).toBeGreaterThan(0);
		expect(compareSemver("18.2.6", "18.2.6")).toBe(0);
		expect(compareSemver("1.2", "1.2.0")).toBe(0);
	});

	test("sorts a non-numeric segment below every release", () => {
		expect(compareSemver("0.1.0", "dev")).toBeGreaterThan(0);
		expect(compareSemver("18.2.9-dev.1", "18.2.6")).toBeLessThan(0);
	});

	test("versionsNewerThan keeps only strictly newer versions", () => {
		expect(versionsNewerThan("18.2.6", ["18.2.5", "18.2.6", "18.2.7", "18.2.8"])).toEqual([
			"18.2.7",
			"18.2.8",
		]);
	});
});

describe("sdk-pins", () => {
	test("collects the scoped pins and nothing else", () => {
		const collected = sdkPins({
			"@oh-my-pi/pi-utils": "18.2.6",
			"@oh-my-pi/pi-wire": "18.2.6",
			"solid-js": "^1.9.15",
		});
		expect(collected).toEqual([
			{ name: "@oh-my-pi/pi-utils", pin: "18.2.6" },
			{ name: "@oh-my-pi/pi-wire", pin: "18.2.6" },
		]);
		expect(uniformPin(collected)).toBe("18.2.6");
	});

	test("non-uniform pins are an error, not a lag warning", () => {
		const mixed = pins("18.2.6", "18.2.5");
		expect(uniformPin(mixed)).toBe(null);
		const findings = checkSdkPins(mixed, { "@oh-my-pi/pi-0": upstream("18.2.8") });
		expect(findings).toHaveLength(1);
		expect(findings[0]?.severity).toBe("error");
		expect(findings[0]?.id).toBe("sdk-pins");
		expect(findings[0]?.message).toContain("18.2.6");
		expect(findings[0]?.message).toContain("18.2.5");
	});

	test("uniform pins behind upstream warn with each package's lag", () => {
		const set = pins("18.2.6", "18.2.6");
		const sweep = { "@oh-my-pi/pi-0": upstream("18.2.8"), "@oh-my-pi/pi-1": upstream("18.2.8") };
		const findings = checkSdkPins(set, sweep);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.severity).toBe("warn");
		expect(findings[0]?.message).toBe(
			"@oh-my-pi/* pinned at 18.2.6, upstream latest is 18.2.8 (2 versions behind)",
		);
		expect(findings[0]?.detail).toContain(
			"@oh-my-pi/pi-0: 18.2.8 (2 versions behind: 18.2.7, 18.2.8)",
		);
	});

	test("pins at the upstream latest are clean, and skipped lookups report nothing", () => {
		expect(checkSdkPins(pins("18.2.8"), { "@oh-my-pi/pi-0": upstream("18.2.8") })).toEqual([]);
		expect(checkSdkPins(pins("18.2.6"), null)).toEqual([]);
	});

	test("a failed lookup warns that the pins are unverified", () => {
		const findings = checkSdkPins(pins("18.2.6"), {
			"@oh-my-pi/pi-0": { ok: false, error: "ENOTFOUND" },
		});
		expect(findings).toHaveLength(1);
		expect(findings[0]?.severity).toBe("warn");
		expect(findings[0]?.message).toContain("unverified");
		expect(findings[0]?.detail).toContain("ENOTFOUND");
	});
});

describe("docs-checkboxes", () => {
	test("reports an unchecked box with file:line", () => {
		const findings = scanCheckboxes(
			file("docs/release.md", "# Title\n\n- [x] shipped\n- [ ] push to GitHub\n"),
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.id).toBe("docs-checkboxes");
		expect(findings[0]?.severity).toBe("warn");
		expect(findings[0]?.message).toBe("docs/release.md:4 unchecked box");
		expect(findings[0]?.detail).toBe("- [ ] push to GitHub");
	});

	test("flags nested boxes and ignores prose that quotes the marker", () => {
		const findings = scanCheckboxes(
			file(
				"docs/release.md",
				"  - [ ] nested\n- a warning for an unchecked `- [ ]` box\n- [x] done\n",
			),
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.message).toBe("docs/release.md:1 unchecked box");
	});

	test("the clone tracker file is excluded from the scan", () => {
		expect(CHECKBOX_SKIPPED["docs/clone-plan.md"]).toBe(true);
	});
});

describe("docs-links", () => {
	const exists = (target: string): boolean => target === "docs/release.md";

	test("a resolvable relative link reports nothing", () => {
		expect(
			scanRelativeLinks(file("docs/guide.md", "see [release](release.md#preflight)"), exists),
		).toEqual([]);
	});

	test("a relative link that resolves to nothing warns", () => {
		const findings = scanRelativeLinks(file("docs/guide.md", "see [gone](./gone.md)"), exists);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.message).toBe(
			"docs/guide.md:1 relative link resolves to nothing: ./gone.md",
		);
	});

	test("skips routes, URLs, mailto and anchors", () => {
		const content = [
			"[a](/project/release/)",
			"[b](https://example.com/x.md)",
			"[c](mailto:someone@example.com)",
			"[d](#section)",
			"[e](<release.md>)",
		].join("\n");
		expect(scanRelativeLinks(file("docs/guide.md", content), exists)).toEqual([]);
	});
});

describe("docs-gate-list", () => {
	const gate = [
		["bun", "run", "check:types"],
		["bun", "e2e/onboarding.ts"],
	];

	test("warns per file and command that is missing from the docs", () => {
		const findings = checkGateList(gate, [
			file("docs/release.md", gate.map((command) => `- \`${command.join(" ")}\``).join("\n")),
			file("docs/src/content/docs/project/release.md", "gate: `bun run check:types`"),
		]);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.id).toBe("docs-gate-list");
		expect(findings[0]?.message).toBe(
			"docs/src/content/docs/project/release.md does not mention the gate command: bun e2e/onboarding.ts",
		);
	});

	test("a complete gate list reports nothing", () => {
		const content = gate.map((command) => `- \`${command.join(" ")}\``).join("\n");
		expect(checkGateList(gate, [file("docs/release.md", content)])).toEqual([]);
	});
});

describe("docs-sdk-literals", () => {
	const input = {
		pin: "18.2.6",
		sdkVersions: new Set(["0.1.0", "17.1.8", "18.2.6", "18.2.8"]),
		repoVersions: new Set(["0.1.0", "0.1.1"]),
	};

	test("flags an SDK version older than the pin", () => {
		const findings = scanSdkLiterals(
			file("docs/notes.md", "pinned SDK 17.1.8. Phases follow.\n"),
			input,
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.message).toBe(
			"docs/notes.md:1 stale @oh-my-pi version literal: 17.1.8 (current pin 18.2.6)",
		);
	});

	test("leaves the frozen clone docs alone (design-time SDK facts)", () => {
		const content = "pinned SDK 17.1.8. Phases implement these frozen shapes.\n";
		for (const path of [
			"docs/clone-contracts.md",
			"docs/clone-design.md",
			"docs/clone-plan.md",
			"docs/clone-summary.md",
		]) {
			expect(scanSdkLiterals(file(path, content), input)).toEqual([]);
		}
	});

	test("leaves the current pin, the repo's own versions and non-SDK numbers alone", () => {
		const content = [
			"pinned SDK 18.2.6",
			"omp-web 0.1.0 shipped", // a repo version that also exists as an SDK version
			"Bun 1.4.0 or newer",
			"trusted proxies such as 127.0.0.1 and 10.0.0.0/8",
			"@typescript/native-preview 7.0.0-dev.20260707.2",
		].join("\n");
		expect(scanSdkLiterals(file("docs/notes.md", content), input)).toEqual([]);
	});
});

describe("arguments, exit codes and report text", () => {
	test("parses the three flags and rejects anything else", () => {
		expect(parsePreflightArgs(["--strict", "--json", "--offline"])).toEqual({
			ok: true,
			args: { strict: true, json: true, offline: true },
		});
		expect(parsePreflightArgs([])).toEqual({
			ok: true,
			args: { strict: false, json: false, offline: false },
		});
		const bad = parsePreflightArgs(["--nope"]);
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.error).toContain("usage: bun scripts/preflight.ts");
	});

	test("exit 1 on errors, and on warnings only under --strict", () => {
		const error: Finding = { id: "sdk-pins", severity: "error", message: "pins disagree" };
		const warn: Finding = { id: "repo-state", severity: "warn", message: "unpushed commits" };
		expect(exitCode([error, warn], false)).toBe(1);
		expect(exitCode([warn], false)).toBe(0);
		expect(exitCode([warn], true)).toBe(1);
		expect(exitCode([], true)).toBe(0);
	});

	test("summarize counts both severities and mirrors the exit code", () => {
		const warn: Finding = { id: "repo-state", severity: "warn", message: "unpushed commits" };
		const error: Finding = { id: "sdk-pins", severity: "error", message: "pins disagree" };
		expect(
			summarize([warn], { strict: false, offline: true, skipped: ["sdk-pins (--offline)"] }),
		).toEqual({
			errors: 0,
			warnings: 1,
			skipped: ["sdk-pins (--offline)"],
			offline: true,
			strict: false,
			ok: true,
		});
		const strict = summarize([warn, error], { strict: true, offline: false });
		expect(strict.errors).toBe(1);
		expect(strict.warnings).toBe(1);
		expect(strict.ok).toBe(false);
	});

	test("the report groups errors before warnings and names the skipped checks", () => {
		const findings: Finding[] = [
			{ id: "repo-state", severity: "warn", message: "HEAD is 2 commits ahead of origin/main" },
			{ id: "sdk-pins", severity: "error", message: "pins disagree", detail: "a\nb" },
		];
		const summary = summarize(findings, {
			strict: false,
			offline: true,
			skipped: ["sdk-pins (--offline)"],
		});
		const report = formatReport(findings, summary);
		expect(report.split("\n")[0]).toBe("preflight: 1 error, 1 warning");
		expect(report.indexOf("errors:")).toBeLessThan(report.indexOf("warnings:"));
		expect(report).toContain("  sdk-pins: pins disagree\n      a\n      b");
		expect(report).toContain("skipped:\n  sdk-pins (--offline)");
	});
});

/** Scratch repository for the wired run: uniform pins, docs with drift. */
function writeRepo(): string {
	const root = tempDir("preflight-");
	mkdirSync(join(root, "docs/src/content/docs/project"), { recursive: true });
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify(
			{
				name: "omp-web",
				version: "0.1.1",
				dependencies: { "@oh-my-pi/pi-utils": "18.2.6", "solid-js": "^1.9.15" },
			},
			null,
			"\t",
		),
	);
	writeFileSync(
		join(root, "CHANGELOG.md"),
		"# Changelog\n\n## v0.1.1, 2026-08-20\n\n## v0.1.0, 2026-08-20\n",
	);
	const gate = [
		["bun", "run", "check:types"],
		["bun", "run", "format:check"],
		["bun", "run", "build:web"],
		["bun", "run", "test"],
		["bun", "e2e/onboarding.ts"],
	];
	// The repo copy documents the whole gate; the site guide is missing the last command.
	writeFileSync(
		join(root, "docs/release.md"),
		gate.map((command) => `- \`${command.join(" ")}\``).join("\n"),
	);
	writeFileSync(
		join(root, "docs/src/content/docs/project/release.md"),
		gate
			.slice(0, 4)
			.map((command) => `- \`${command.join(" ")}\``)
			.join("\n"),
	);
	writeFileSync(
		join(root, "docs/notes.md"),
		[
			"# Notes",
			"",
			"- [ ] verify the sandbox",
			"see [release](release.md) and [missing](./gone.md)",
			"pinned SDK 17.1.8, omp-web 0.1.0",
			"",
		].join("\n"),
	);
	// The tracker's boxes are live work: the checkbox scan must skip this file.
	writeFileSync(join(root, "docs/clone-plan.md"), "# Clone plan\n\n- [ ] P5.3 kubernetes\n");
	return root;
}

/** Fake git/gh/npm: a fixed repository state, no processes. */
function fakeRunner(calls: string[][]): CommandRunner {
	return async (args): Promise<CommandResult> => {
		calls.push([...args]);
		const line = args.join(" ");
		if (line === "git rev-list --count origin/main..HEAD")
			return { status: 0, stdout: "2\n", stderr: "" };
		if (line === "gh auth status") {
			return { status: 1, stdout: "", stderr: "You are not logged into any GitHub hosts." };
		}
		if (args[0] === "npm") {
			return {
				status: 0,
				stdout: JSON.stringify({
					version: "18.2.8",
					versions: ["0.1.0", "17.1.8", "18.2.6", "18.2.7", "18.2.8"],
				}),
				stderr: "",
			};
		}
		return { status: 127, stdout: "", stderr: `unexpected command: ${line}` };
	};
}

describe("runChecks", () => {
	test("reports git, gh and docs drift from a scratch repository", async () => {
		const calls: string[][] = [];
		const root = writeRepo();
		const { findings, skipped } = await runChecks({ root, offline: false, run: fakeRunner(calls) });

		expect(messages(findings.filter((finding) => finding.id === "sdk-pins"))).toBe(
			"@oh-my-pi/* pinned at 18.2.6, upstream latest is 18.2.8 (2 versions behind)",
		);
		const repoState = messages(findings.filter((finding) => finding.id === "repo-state"));
		expect(repoState).toContain("HEAD is 2 commits ahead of origin/main");
		expect(repoState).toContain("gh is not authenticated");
		// docs/notes.md only: the clone tracker is skipped and the release docs carry the gate.
		expect(messages(findings.filter((finding) => finding.id === "docs-checkboxes"))).toBe(
			"docs/notes.md:3 unchecked box",
		);
		expect(messages(findings.filter((finding) => finding.id === "docs-links"))).toBe(
			"docs/notes.md:4 relative link resolves to nothing: ./gone.md",
		);
		expect(messages(findings.filter((finding) => finding.id === "docs-gate-list"))).toBe(
			"docs/src/content/docs/project/release.md does not mention the gate command: bun e2e/onboarding.ts",
		);
		expect(messages(findings.filter((finding) => finding.id === "docs-sdk-literals"))).toBe(
			"docs/notes.md:5 stale @oh-my-pi version literal: 17.1.8 (current pin 18.2.6)",
		);
		expect(skipped).toEqual([]);
		expect(calls.filter((call) => call[0] === "npm")).toHaveLength(1);
		expect(exitCode(findings, false)).toBe(0);
	});

	test("--offline runs no npm check and reports the skips", async () => {
		const calls: string[][] = [];
		const root = writeRepo();
		const { findings, skipped } = await runChecks({ root, offline: true, run: fakeRunner(calls) });

		expect(calls.some((call) => call[0] === "npm")).toBe(false);
		expect(skipped).toEqual([
			"sdk-pins (--offline): upstream npm versions not queried",
			"docs-sdk-literals (--offline): published SDK version set not queried",
		]);
		expect(messages(findings)).not.toContain("upstream latest");
		// Everything that does not need npm still runs.
		const repoState = messages(findings.filter((finding) => finding.id === "repo-state"));
		expect(repoState).toContain("HEAD is 2 commits ahead of origin/main");
		expect(repoState).toContain("gh is not authenticated");
		expect(findings.filter((finding) => finding.id === "docs-links")).toHaveLength(1);
		expect(summarize(findings, { strict: true, offline: true, skipped }).ok).toBe(false);
	});
});
