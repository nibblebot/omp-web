/**
 * Standalone release preflight: `bun scripts/preflight.ts [--strict] [--json] [--offline]`.
 *
 * Reports the drift that makes a release wrong or the published docs stale:
 * @oh-my-pi pin disagreement and lag behind upstream npm, the patch map
 * against patches/ and bun.lock, unpushed commits, gh auth, unchecked docs
 * boxes, dead relative doc links, a documented gate list that disagrees with
 * GATE_COMMANDS, and stale SDK version literals in the docs. GitHub Pages
 * builds the site from main, so the repo-state unpushed-commit warning is also
 * the stale-site signal.
 *
 * Standalone by design (docs/release.md, "Preflight"): scripts/release.ts
 * never calls it, so a release can run while findings are present. Exit 0 when
 * clean, 1 when any error finding exists, and 1 on warnings under --strict.
 * The report prints to stdout; usage and runtime failures print
 * `preflight: error: <msg>` on stderr.
 *
 * Every check is a function over explicit inputs (dependency maps, file lists,
 * file contents, an injected command runner), so the whole report is testable
 * without git, gh or the network. `runChecks` wires the checks to the
 * repository; `main` wires it to argv.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { GATE_COMMANDS } from "./release";

export type Severity = "error" | "warn";

/** One id per check below; every finding carries the id of its check. */
export type CheckId =
	| "sdk-pins"
	| "patch-coherence"
	| "repo-state"
	| "docs-checkboxes"
	| "docs-links"
	| "docs-gate-list"
	| "docs-sdk-literals";

/** One preflight result. `detail` is optional extra context (per-package
 *  lines, excerpts), printed indented under the message. */
export interface Finding {
	id: CheckId;
	severity: Severity;
	message: string;
	detail?: string;
}

const USAGE = "usage: bun scripts/preflight.ts [--strict] [--json] [--offline]";

/** Parsed CLI surface for the preflight. */
export interface PreflightArgs {
	/** Warnings make the process exit 1 (default: only errors do). */
	strict: boolean;
	/** Print `{ findings, summary }` as JSON instead of the text report. */
	json: boolean;
	/** Never invoke npm: the npm-backed checks report as skipped. */
	offline: boolean;
}

/** Pure argv parsing: three boolean flags, nothing else. */
export function parsePreflightArgs(
	argv: string[],
): { ok: true; args: PreflightArgs } | { ok: false; error: string } {
	const args: PreflightArgs = { strict: false, json: false, offline: false };
	for (const arg of argv) {
		if (arg === "--strict") {
			args.strict = true;
			continue;
		}
		if (arg === "--json") {
			args.json = true;
			continue;
		}
		if (arg === "--offline") {
			args.offline = true;
			continue;
		}
		return { ok: false, error: `unknown argument: ${arg}\n${USAGE}` };
	}
	return { ok: true, args };
}

/**
 * Numeric dot-split semver compare, negative when a < b. Local on purpose:
 * preflight must not import the @oh-my-pi SDK (or the update pipeline) to
 * compare two version strings. Semantics match cli/update.ts compareVersions:
 * missing segments count as 0, and a non-numeric segment ("dev") sorts below
 * every number.
 */
export function compareSemver(a: string, b: string): number {
	const pa = a.split(".");
	const pb = b.split(".");
	const n = Math.max(pa.length, pb.length);
	for (let i = 0; i < n; i++) {
		const x = pa[i] === undefined ? 0 : Number(pa[i]);
		const y = pb[i] === undefined ? 0 : Number(pb[i]);
		if (Number.isNaN(x) && Number.isNaN(y)) continue;
		if (Number.isNaN(x)) return -1;
		if (Number.isNaN(y)) return 1;
		if (x !== y) return x < y ? -1 : 1;
	}
	return 0;
}

/** Published versions strictly newer than `pin`, in input order. */
export function versionsNewerThan(pin: string, versions: readonly string[]): string[] {
	return versions.filter((version) => compareSemver(version, pin) > 0);
}

/** `1 commit` / `2 commits`, for the counts that print in messages. */
export function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export const SDK_SCOPE = "@oh-my-pi/";

/** One @oh-my-pi dependency pin. */
export interface SdkPin {
	/** Package name, e.g. `@oh-my-pi/pi-utils`. */
	name: string;
	/** Exact version from dependencies. */
	pin: string;
}

/** The @oh-my-pi/* pins in a dependencies map, in package.json order. */
export function sdkPins(dependencies: Record<string, string>): SdkPin[] {
	return Object.entries(dependencies)
		.filter(([name]) => name.startsWith(SDK_SCOPE))
		.map(([name, pin]) => ({ name, pin }));
}

/** The version every pin agrees on, or null when they disagree (or there are none). */
export function uniformPin(pins: readonly SdkPin[]): string | null {
	const distinct = new Set(pins.map((pin) => pin.pin));
	return distinct.size === 1 ? (pins[0]?.pin ?? null) : null;
}

/** One package's upstream state: the latest published version plus the full list. */
export type UpstreamResult =
	| { ok: true; latest: string; versions: string[] }
	| { ok: false; error: string };

/** Upstream lookups keyed by package name; null when they were skipped (--offline). */
export type UpstreamSweep = Record<string, UpstreamResult> | null;

/**
 * `sdk-pins`: the @oh-my-pi packages are released as one set, so disagreeing
 * pins are an error (the runtime and the CLI would be built against different
 * SDK versions) and a uniform pin behind the upstream npm latest is a warning.
 * `sweep` is null when the lookups were skipped: a skipped check reports
 * nothing here, the caller records the skip.
 */
export function checkSdkPins(pins: readonly SdkPin[], sweep: UpstreamSweep): Finding[] {
	if (pins.length === 0) return [];
	const pin = uniformPin(pins);
	if (pin === null) {
		return [
			{
				id: "sdk-pins",
				severity: "error",
				message: `@oh-my-pi/* pins disagree: ${pins.map((p) => `${p.name}@${p.pin}`).join(", ")}`,
				detail: "the packages move together; pin them to the same version",
			},
		];
	}
	if (sweep === null) return [];
	const lines: string[] = [];
	const behind: { latest: string; newer: string[] }[] = [];
	let failed = 0;
	for (const { name } of pins) {
		const result = sweep[name];
		if (result === undefined || !result.ok) {
			failed++;
			lines.push(
				`${name}: upstream lookup failed (${result === undefined ? "no result" : result.error})`,
			);
			continue;
		}
		const newer = versionsNewerThan(pin, result.versions);
		if (newer.length > 0) {
			behind.push({ latest: result.latest, newer });
			lines.push(
				`${name}: ${result.latest} (${plural(newer.length, "version")} behind: ${newer.join(", ")})`,
			);
			continue;
		}
		lines.push(
			compareSemver(result.latest, pin) === 0
				? `${name}: ${result.latest} (current)`
				: `${name}: ${result.latest} (older than the pin)`,
		);
	}
	const detail = lines.join("\n");
	if (behind.length > 0) {
		const newest = behind.reduce((a, b) => (compareSemver(b.latest, a.latest) > 0 ? b : a));
		return [
			{
				id: "sdk-pins",
				severity: "warn",
				message: `@oh-my-pi/* pinned at ${pin}, upstream latest is ${newest.latest} (${plural(newest.newer.length, "version")} behind)`,
				detail,
			},
		];
	}
	if (failed > 0) {
		return [
			{
				id: "sdk-pins",
				severity: "warn",
				message: `upstream npm lookup failed for ${failed} of ${pins.length} @oh-my-pi/* packages; their pins are unverified`,
				detail,
			},
		];
	}
	return [];
}

/** Union of the published versions of every package that answered, or null when none did. */
export function publishedSdkVersions(sweep: UpstreamSweep): ReadonlySet<string> | null {
	if (sweep === null) return null;
	const versions = new Set<string>();
	for (const result of Object.values(sweep)) {
		if (!result.ok) continue;
		for (const version of result.versions) versions.add(version);
	}
	return versions.size === 0 ? null : versions;
}

export interface PatchCoherenceInput {
	/** package.json dependencies (the pins the patch keys must match). */
	dependencies: Record<string, string>;
	/** package.json patchedDependencies. */
	patchedDependencies: Record<string, string>;
	/** Every file under patches/, as repo-relative POSIX paths. */
	patchFiles: readonly string[];
	/** bun.lock's patchedDependencies, or null when the lock file was unreadable. */
	lockPatchedDependencies: Record<string, string> | null;
}

/** Same file, different spelling: `./x` vs `x`, backslashes, doubled slashes. */
export function normalizePatchPath(path: string): string {
	return path
		.replace(/\\/g, "/")
		.replace(/^\.\//, "")
		.replace(/\/{2,}/g, "/");
}

/**
 * `patch-coherence`: the patch map in package.json, the files in patches/, and
 * bun.lock's copy of the map describe one thing, so any disagreement is an
 * error (bun installs the patch it finds in the lock file, not the one the
 * release README points at).
 */
export function checkPatchCoherence(input: PatchCoherenceInput): Finding[] {
	const findings: Finding[] = [];
	const files = new Set(input.patchFiles.map(normalizePatchPath));
	const referenced = new Set<string>();
	for (const [key, target] of Object.entries(input.patchedDependencies)) {
		const path = normalizePatchPath(target);
		referenced.add(path);
		if (!files.has(path)) {
			findings.push({
				id: "patch-coherence",
				severity: "error",
				message: `patchedDependencies["${key}"] points at a missing patch file: ${target}`,
			});
		}
		const at = key.lastIndexOf("@");
		if (at > 0) {
			const name = key.slice(0, at);
			const version = key.slice(at + 1);
			const pin = input.dependencies[name];
			if (pin !== undefined && pin !== version) {
				findings.push({
					id: "patch-coherence",
					severity: "error",
					message: `patchedDependencies key ${key} does not match the ${name} pin ${pin}`,
				});
			}
		}
	}
	for (const file of files) {
		if (referenced.has(file)) continue;
		findings.push({
			id: "patch-coherence",
			severity: "error",
			message: `${file} is not referenced by patchedDependencies (orphan patch file)`,
		});
	}
	if (input.lockPatchedDependencies === null) return findings;
	const lock = input.lockPatchedDependencies;
	for (const [key, target] of Object.entries(input.patchedDependencies)) {
		const locked = lock[key];
		if (locked === undefined) {
			findings.push({
				id: "patch-coherence",
				severity: "error",
				message: `bun.lock has no patchedDependencies entry for ${key}`,
			});
			continue;
		}
		if (normalizePatchPath(locked) !== normalizePatchPath(target)) {
			findings.push({
				id: "patch-coherence",
				severity: "error",
				message: `bun.lock maps ${key} to ${locked}, package.json maps it to ${target}`,
			});
		}
	}
	for (const key of Object.keys(lock)) {
		if (input.patchedDependencies[key] !== undefined) continue;
		findings.push({
			id: "patch-coherence",
			severity: "error",
			message: `bun.lock has an extra patchedDependencies entry: ${key}`,
		});
	}
	return findings;
}

/** Captured result of one command; status -1 when the spawn itself failed. */
export interface CommandResult {
	status: number;
	stdout: string;
	stderr: string;
}

/** Command seam: `run(["git", "..."])`. Tests inject fakes; main uses Bun.spawn. */
export type CommandRunner = (args: readonly string[]) => Promise<CommandResult>;

/** 30s cap: a hung git/gh/npm process must not hang the preflight. */
const COMMAND_TIMEOUT_MS = 30_000;

/** Default runner: Bun.spawn with both pipes drained concurrently. */
export const spawnRunner: CommandRunner = async (args) => {
	const proc = Bun.spawn([...args], {
		stdout: "pipe",
		stderr: "pipe",
		timeout: COMMAND_TIMEOUT_MS,
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const status = await proc.exited;
	return { status, stdout, stderr };
};

/** `run` with spawn failures (a missing binary) folded into a status. */
async function safeRun(run: CommandRunner, args: readonly string[]): Promise<CommandResult> {
	try {
		return await run(args);
	} catch (err) {
		return { status: -1, stdout: "", stderr: errorMessage(err) };
	}
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** First non-empty output line, for one-line details. */
function firstLine(text: string): string {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length > 0) return trimmed;
	}
	return "";
}

/** Non-empty text or undefined, so empty details stay out of the report. */
function maybe(text: string): string | undefined {
	return text.length > 0 ? text : undefined;
}

/** The branch the release pushes to and tags from. */
export const MAIN_BRANCH = "origin/main";

/**
 * `repo-state`: the release pushes to origin/main and its preconditions require
 * an authenticated gh CLI, so commits that only exist locally and a missing gh
 * login are release-relevant.
 */
export async function checkRepoState(run: CommandRunner): Promise<Finding[]> {
	const findings: Finding[] = [];
	const count = await safeRun(run, ["git", "rev-list", "--count", `${MAIN_BRANCH}..HEAD`]);
	if (count.status !== 0) {
		findings.push({
			id: "repo-state",
			severity: "warn",
			message: `${MAIN_BRANCH} is not available; cannot tell whether HEAD is pushed`,
			detail: maybe(firstLine(count.stderr)),
		});
	} else {
		const ahead = Number.parseInt(count.stdout.trim(), 10);
		if (Number.isFinite(ahead) && ahead > 0) {
			findings.push({
				id: "repo-state",
				severity: "warn",
				message: `HEAD is ${plural(ahead, "commit")} ahead of ${MAIN_BRANCH}; the release pushes to origin/main`,
			});
		}
	}
	const auth = await safeRun(run, ["gh", "auth", "status"]);
	if (auth.status !== 0) {
		findings.push({
			id: "repo-state",
			severity: "warn",
			message: "gh is not authenticated; the release preconditions require an authenticated gh CLI",
			detail: maybe(firstLine(auth.stderr)),
		});
	}
	return findings;
}

/** A docs file's repo-relative path plus its contents. */
export interface DocsFile {
	path: string;
	content: string;
}

/** The documents of record for the release contract: this repo's copy and the site page. */
export const RELEASE_DOCS: Record<string, true> = {
	"docs/release.md": true,
	"docs/src/content/docs/project/release.md": true,
};

/**
 * The clone plan's own phased execution tracker: its `- [ ]` boxes are live
 * clone work, not documentation drift, so the checkbox scan skips the file.
 */
export const CHECKBOX_SKIPPED: Record<string, true> = { "docs/clone-plan.md": true };

/**
 * Docs files scanned by the text checks: `docs/*.md` plus the markdown files
 * under the Starlight content tree `docs/src/content/docs`, repo-relative.
 */
export function docsMarkdownFiles(root: string): string[] {
	const dir = join(root, "docs");
	const files = new Set<string>();
	for (const pattern of ["*.md", "src/content/docs/**/*.md"]) {
		for (const rel of new Bun.Glob(pattern).scanSync({ cwd: dir })) {
			files.add(`docs/${rel.split(sep).join("/")}`);
		}
	}
	return [...files].sort();
}

/** Every file under patches/, repo-relative (empty when the directory is absent). */
export function patchFiles(root: string): string[] {
	const dir = join(root, "patches");
	if (!existsSync(dir)) return [];
	return [...new Bun.Glob("**/*").scanSync({ cwd: dir })]
		.map((rel) => `patches/${rel.split(sep).join("/")}`)
		.sort();
}

/** One-line excerpt for a report detail (trimmed, capped at 120 chars). */
function excerpt(line: string): string {
	const trimmed = line.trim();
	if (trimmed.length <= 120) return trimmed;
	return `${trimmed.slice(0, 117)}...`;
}

/** A task-list box that is unchecked. */
const UNCHECKED_BOX = /^[ \t]*- \[ \]/;

/**
 * `docs-checkboxes`: an unchecked box in the docs is release-relevant because
 * those pages double as the operations runbook. The pattern is line-anchored,
 * so prose that quotes `- [ ]` in inline code is not a finding.
 */
export function scanCheckboxes(file: DocsFile): Finding[] {
	const findings: Finding[] = [];
	file.content.split("\n").forEach((line, index) => {
		if (!UNCHECKED_BOX.test(line)) return;
		findings.push({
			id: "docs-checkboxes",
			severity: "warn",
			message: `${file.path}:${index + 1} unchecked box`,
			detail: excerpt(line),
		});
	});
	return findings;
}

/** Inline markdown link or image target, bare or angle-bracketed, with an optional title. */
const LINK_TARGET = /\]\(\s*(?:<([^>]*)>|([^)\s]*))\s*(?:"[^"]*")?\s*\)/g;

/** Targets the link check ignores: site routes, URLs of any scheme, anchors. */
export function isAbsoluteLinkTarget(target: string): boolean {
	return (
		target.startsWith("#") || target.startsWith("/") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)
	);
}

/**
 * `docs-links`: a relative link that resolves to nothing is a dead end for a
 * reader. Targets resolve against the linking file's directory (fragment and
 * query stripped); absolute site routes, URLs, `mailto:` and bare `#anchor`
 * targets are skipped. `exists` is the filesystem seam.
 */
export function scanRelativeLinks(file: DocsFile, exists: (path: string) => boolean): Finding[] {
	const findings: Finding[] = [];
	const from = dirname(file.path);
	file.content.split("\n").forEach((line, index) => {
		for (const match of line.matchAll(LINK_TARGET)) {
			const raw = (match[1] ?? match[2] ?? "").trim();
			if (raw === "" || isAbsoluteLinkTarget(raw)) continue;
			const target = raw.replace(/[#?].*$/, "");
			if (target === "" || exists(join(from, target))) continue;
			findings.push({
				id: "docs-links",
				severity: "warn",
				message: `${file.path}:${index + 1} relative link resolves to nothing: ${raw}`,
			});
		}
	});
	return findings;
}

/**
 * `docs-gate-list`: the release docs are the contract for what a release runs,
 * so every command in GATE_COMMANDS must appear verbatim (the space-joined
 * line) in both. A command split across lines or renamed in the docs means a
 * reader gets a gate list that disagrees with the script.
 */
export function checkGateList(
	gate: readonly (readonly string[])[],
	files: readonly DocsFile[],
): Finding[] {
	const findings: Finding[] = [];
	for (const file of files) {
		for (const command of gate) {
			const line = command.join(" ");
			if (file.content.includes(line)) continue;
			findings.push({
				id: "docs-gate-list",
				severity: "warn",
				message: `${file.path} does not mention the gate command: ${line}`,
			});
		}
	}
	return findings;
}

/**
 * Version literals in prose: `x.y.z` as a standalone token. The lookarounds
 * keep IP addresses (`127.0.0.1`, `10.0.0.0/8`) and compound versions
 * (`7.0.0-dev.2`) out of the scan while still matching a sentence-final
 * `17.1.8.`.
 */
const VERSION_TOKEN = /(?<![\d.])(\d+\.\d+\.\d+)(?![\d-])(?!\.\d)/g;

export interface SdkLiteralInput {
	/** The uniform @oh-my-pi pin the docs should quote. */
	pin: string;
	/** Published @oh-my-pi versions (the seven packages are one set). */
	sdkVersions: ReadonlySet<string>;
	/** The repo's own released versions, never flagged. */
	repoVersions: ReadonlySet<string>;
}

/**
 * The frozen clone design/ledger docs. By charter they record design-time SDK
 * facts (the P0 investigation ran against 17.1.8), so an old pin literal there
 * is history, not drift; flagging it would train readers to ignore the report.
 */
const FROZEN_SDK_LITERAL_DOCS: Record<string, true> = {
	"docs/clone-contracts.md": true,
	"docs/clone-design.md": true,
	"docs/clone-plan.md": true,
	"docs/clone-summary.md": true,
};

/**
 * `docs-sdk-literals`: a docs page quoting an SDK version older than the
 * current pin sends readers to a stale interface. Only published @oh-my-pi
 * versions are flagged, and the repo's own versions are excluded because early
 * 0.x SDK numbers collide with them. The frozen clone docs are excluded by
 * charter (FROZEN_SDK_LITERAL_DOCS).
 */
export function scanSdkLiterals(file: DocsFile, input: SdkLiteralInput): Finding[] {
	if (FROZEN_SDK_LITERAL_DOCS[file.path] === true) return [];
	const findings: Finding[] = [];
	file.content.split("\n").forEach((line, index) => {
		for (const match of line.matchAll(VERSION_TOKEN)) {
			const value = match[1] ?? "";
			if (input.repoVersions.has(value) || !input.sdkVersions.has(value)) continue;
			if (compareSemver(value, input.pin) >= 0) continue;
			findings.push({
				id: "docs-sdk-literals",
				severity: "warn",
				message: `${file.path}:${index + 1} stale @oh-my-pi version literal: ${value} (current pin ${input.pin})`,
			});
		}
	});
	return findings;
}

/**
 * The repo's own released versions: package.json's version plus every
 * `## v<x.y.z>` heading in CHANGELOG.md.
 */
export function repoVersions(version: string, changelog: string | null): ReadonlySet<string> {
	const versions = new Set<string>();
	if (version !== "") versions.add(version);
	if (changelog !== null) {
		for (const match of changelog.matchAll(/^## v(\d+\.\d+\.\d+)/gm)) {
			if (match[1] !== undefined) versions.add(match[1]);
		}
	}
	return versions;
}

/** Exit status the findings imply: 1 on errors, 1 on warnings under --strict. */
export function exitCode(findings: readonly Finding[], strict: boolean): 0 | 1 {
	if (findings.some((finding) => finding.severity === "error")) return 1;
	if (strict && findings.some((finding) => finding.severity === "warn")) return 1;
	return 0;
}

/** The `summary` half of the `--json` payload. */
export interface PreflightSummary {
	errors: number;
	warnings: number;
	/** Checks that could not run, with why (`--offline`, unreadable lock file). */
	skipped: string[];
	offline: boolean;
	strict: boolean;
	/** False when the process exits 1. */
	ok: boolean;
}

export function summarize(
	findings: readonly Finding[],
	opts: { strict: boolean; offline: boolean; skipped?: readonly string[] },
): PreflightSummary {
	const errors = findings.filter((finding) => finding.severity === "error").length;
	return {
		errors,
		warnings: findings.length - errors,
		skipped: [...(opts.skipped ?? [])],
		offline: opts.offline,
		strict: opts.strict,
		ok: exitCode(findings, opts.strict) === 0,
	};
}

/** Human report: counts, then errors, then warnings, then skipped checks. */
export function formatReport(findings: readonly Finding[], summary: PreflightSummary): string {
	const parts = [
		`preflight: ${plural(summary.errors, "error")}, ${plural(summary.warnings, "warning")}`,
	];
	for (const severity of ["error", "warn"] as const) {
		const group = findings.filter((finding) => finding.severity === severity);
		if (group.length === 0) continue;
		parts.push("", `${severity === "error" ? "errors" : "warnings"}:`);
		for (const finding of group) {
			parts.push(`  ${finding.id}: ${finding.message}`);
			if (finding.detail !== undefined && finding.detail !== "") {
				parts.push(...finding.detail.split("\n").map((line) => `      ${line}`));
			}
		}
	}
	if (summary.skipped.length > 0) {
		parts.push("", "skipped:", ...summary.skipped.map((entry) => `  ${entry}`));
	}
	return parts.join("\n");
}

/** A flat string-to-string map from unknown JSON (non-string values dropped). */
function stringMap(value: unknown): Record<string, string> {
	const map: Record<string, string> = {};
	if (typeof value !== "object" || value === null) return map;
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string") map[key] = entry;
	}
	return map;
}

/** Parse a JSON file that must hold an object; throws with the label on any problem. */
function readJsonObject(path: string, label: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		throw new Error(`cannot read ${label}: ${errorMessage(err)}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${label} is not a JSON object`);
	}
	return parsed as Record<string, unknown>;
}

/** bun.lock's patchedDependencies map, or null (with a skip note) when it cannot be read. */
function lockPatchedDependencies(root: string, skipped: string[]): Record<string, string> | null {
	const path = join(root, "bun.lock");
	if (!existsSync(path)) {
		skipped.push(
			"patch-coherence (bun.lock is missing): package.json compared against patches/ only",
		);
		return null;
	}
	try {
		const lock = Bun.JSONC.parse(readFileSync(path, "utf8")) as unknown;
		if (typeof lock !== "object" || lock === null) throw new Error("not an object");
		return stringMap((lock as Record<string, unknown>).patchedDependencies);
	} catch (err) {
		skipped.push(`patch-coherence (bun.lock is unreadable: ${errorMessage(err)})`);
		return null;
	}
}

/** One `npm view <pkg> version versions --json` per package, in parallel. */
export async function sweepUpstreams(
	pins: readonly SdkPin[],
	run: CommandRunner,
): Promise<Record<string, UpstreamResult>> {
	const entries = await Promise.all(
		pins.map(async ({ name }): Promise<[string, UpstreamResult]> => [
			name,
			await lookupUpstream(name, run),
		]),
	);
	return Object.fromEntries(entries);
}

/**
 * The published version list rides along on the version query on purpose: both
 * the behind count and the docs SDK-literal check need it, and one call per
 * package keeps the sweep at one process per package.
 */
async function lookupUpstream(name: string, run: CommandRunner): Promise<UpstreamResult> {
	const result = await safeRun(run, ["npm", "view", name, "version", "versions", "--json"]);
	if (result.status !== 0) {
		return { ok: false, error: firstLine(result.stderr) || `npm view exited ${result.status}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch (err) {
		return { ok: false, error: `unparsable npm output: ${errorMessage(err)}` };
	}
	const record = parsed as { version?: unknown; versions?: unknown };
	const versions = Array.isArray(record.versions)
		? record.versions.filter((version): version is string => typeof version === "string")
		: [];
	const latest: string | undefined =
		typeof record.version === "string" ? record.version : versions[versions.length - 1];
	if (latest === undefined) return { ok: false, error: "npm reported no versions" };
	return { ok: true, latest, versions };
}

export interface PreflightOptions {
	/** Repository root; every relative path resolves against it. */
	root: string;
	offline: boolean;
	/** Command seam (default: Bun.spawn); tests inject a fake. */
	run?: CommandRunner;
}

export interface PreflightOutcome {
	findings: Finding[];
	/** Checks that could not run, with why. */
	skipped: string[];
}

/** Run every check against the repository at `opts.root`. */
export async function runChecks(opts: PreflightOptions): Promise<PreflightOutcome> {
	const run = opts.run ?? spawnRunner;
	const root = opts.root;
	const findings: Finding[] = [];
	const skipped: string[] = [];

	const pkg = readJsonObject(join(root, "package.json"), "package.json");
	const dependencies = stringMap(pkg.dependencies);
	const patchedDependencies = stringMap(pkg.patchedDependencies);
	const pins = sdkPins(dependencies);

	const sweep = opts.offline ? null : await sweepUpstreams(pins, run);
	findings.push(...checkSdkPins(pins, sweep));
	if (sweep === null) skipped.push("sdk-pins (--offline): upstream npm versions not queried");

	findings.push(
		...checkPatchCoherence({
			dependencies,
			patchedDependencies,
			patchFiles: patchFiles(root),
			lockPatchedDependencies: lockPatchedDependencies(root, skipped),
		}),
	);

	findings.push(...(await checkRepoState(run)));

	const docs: DocsFile[] = docsMarkdownFiles(root).map((path) => ({
		path,
		content: readFileSync(join(root, path), "utf8"),
	}));
	for (const file of docs) {
		if (CHECKBOX_SKIPPED[file.path] === true) continue;
		findings.push(...scanCheckboxes(file));
	}
	for (const file of docs) findings.push(...scanRelativeLinks(file, (path) => existsSync(path)));
	findings.push(
		...checkGateList(
			GATE_COMMANDS,
			docs.filter((file) => RELEASE_DOCS[file.path] === true),
		),
	);

	const sdkVersions = publishedSdkVersions(sweep);
	const pin = uniformPin(pins);
	if (sdkVersions === null) {
		skipped.push(
			opts.offline
				? "docs-sdk-literals (--offline): published SDK version set not queried"
				: "docs-sdk-literals (no upstream SDK version set available)",
		);
	} else if (pin === null) {
		skipped.push("docs-sdk-literals (the @oh-my-pi/* pins disagree; no current pin)");
	} else {
		const changelogPath = join(root, "CHANGELOG.md");
		const literals: SdkLiteralInput = {
			pin,
			sdkVersions,
			repoVersions: repoVersions(
				typeof pkg.version === "string" ? pkg.version : "",
				existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : null,
			),
		};
		for (const file of docs) findings.push(...scanSdkLiterals(file, literals));
	}

	return { findings, skipped };
}

/** Entry point: usage and runtime failures -> `preflight: error: <msg>` on stderr, exit code 1. */
export async function main(argv: string[]): Promise<void> {
	const parsed = parsePreflightArgs(argv);
	if (!parsed.ok) {
		console.error(`preflight: error: ${parsed.error}`);
		process.exitCode = 1;
		return;
	}
	const { strict, json, offline } = parsed.args;
	try {
		const { findings, skipped } = await runChecks({ root: process.cwd(), offline });
		const summary = summarize(findings, { strict, offline, skipped });
		console.log(
			json ? JSON.stringify({ findings, summary }, null, "\t") : formatReport(findings, summary),
		);
		process.exitCode = summary.ok ? 0 : 1;
	} catch (err) {
		console.error(`preflight: error: ${errorMessage(err)}`);
		process.exitCode = 1;
	}
}

if (import.meta.main) {
	void main(process.argv.slice(2));
}
