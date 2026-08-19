/**
 * Unit tests for scripts/release-llm.ts. The LLM path is exercised purely
 * through the spawn seam — no omp subprocess, no network, no auth.
 *
 * The summarizer prompts once per bounded chunk of commits plus once for the
 * overview, so the fake spawn routes responses by prompt content:
 * - group prompts contain `### <heading>` and the `"cls"` output contract;
 * - the overview prompt contains the `"overview"` output contract.
 */

import { describe, expect, test } from "bun:test";
import { runTurn, summarizeChangelog } from "./release-llm";
import type { SpawnFn, SummarizeInput } from "./release-llm";

const COMMIT_LINK_BASE = "https://github.com/nibblebot/omp-web/commit/";

const INPUT: SummarizeInput = {
	version: "0.2.0",
	groups: [
		{
			cls: "feat",
			heading: "Features",
			commits: [
				{ hash: "a1b2c3d4", subject: "add session switching" },
				{ hash: "e5f6a7b8", subject: "support custom themes" },
			],
		},
		{
			cls: "fix",
			heading: "Bug fixes",
			commits: [{ hash: "c9d0e1f2", subject: "fix idle timeout crash" }],
		},
	],
};

const OVERVIEW =
	"This release adds session switching and custom themes, and fixes the idle-timeout crash.";

const FEAT_GROUP_JSON = JSON.stringify({
	cls: "feat",
	bullets: [
		`Switch between sessions seamlessly. ([a1b2c3d4](${COMMIT_LINK_BASE}a1b2c3d4))`,
		`Pick from custom themes. ([e5f6a7b8](${COMMIT_LINK_BASE}e5f6a7b8))`,
	],
});

const FIX_GROUP_JSON = JSON.stringify({
	cls: "fix",
	bullets: [`Fix a crash on idle timeout. ([c9d0e1f2](${COMMIT_LINK_BASE}c9d0e1f2))`],
});

const OVERVIEW_JSON = JSON.stringify({ overview: OVERVIEW });

interface SpawnOptions {
	/** Response for group-chunk prompts; routed by heading. */
	groupJson?: string;
	/** Response for the overview prompt. */
	overviewJson?: string;
	rejectAll?: boolean;
	never?: boolean;
	throwing?: boolean;
}

interface SpawnCall {
	args: string[];
	prompt: string;
}

/** Fake spawn seam: records argv + prompts, no omp subprocess involved. */
function fakeSpawn(opts: SpawnOptions = {}) {
	const calls: SpawnCall[] = [];
	const spawn: SpawnFn = async (args, prompt) => {
		calls.push({ args, prompt });
		if (opts.never) return await new Promise<never>(() => {});
		if (opts.throwing) throw new Error("spawn failed");
		if (opts.rejectAll) return { stdout: "", code: 1 };
		let stdout = opts.groupJson ?? FIX_GROUP_JSON;
		if (prompt.includes('"overview"')) stdout = opts.overviewJson ?? OVERVIEW_JSON;
		else if (prompt.includes("### Features")) stdout = opts.groupJson ?? FEAT_GROUP_JSON;
		return { stdout, code: 0 };
	};
	return { spawn, calls };
}

/** The omp flags every real invocation carries (order fixed by runTurn). */
const OMP_FLAGS = ["-p", "--no-pty", "--no-session"];

describe("summarizeChangelog with a fake spawn", () => {
	test("resolves a valid draft: one prompt per chunk plus the overview", async () => {
		const { spawn, calls } = fakeSpawn();
		const draft = await summarizeChangelog(INPUT, { spawn });
		expect(draft).not.toBeNull();
		expect(draft?.overview).toBe(OVERVIEW);
		expect(draft?.groups).toEqual([
			{ cls: "feat", bullets: JSON.parse(FEAT_GROUP_JSON).bullets },
			{ cls: "fix", bullets: JSON.parse(FIX_GROUP_JSON).bullets },
		]);
		// 2 group chunks + 1 overview turn; every call carries the omp flags.
		expect(calls).toHaveLength(3);
		for (const call of calls) {
			for (const flag of OMP_FLAGS) expect(call.args).toContain(flag);
		}
		expect(calls[2].prompt).toContain('"overview"');
	});

	test("chunks a group larger than the chunk size into multiple prompts", async () => {
		const many = Array.from({ length: 35 }, (_, i) => ({
			hash: `hash${i.toString().padStart(4, "0")}`,
			subject: `commit number ${i}`,
		}));
		const { spawn, calls } = fakeSpawn();
		// Override routing: answer each group prompt with bullets built from the
		// hashes present in that prompt.
		const chunkSpawn: SpawnFn = async (args, prompt) => {
			calls.push({ args, prompt });
			if (prompt.includes('"overview"')) return { stdout: OVERVIEW_JSON, code: 0 };
			const hashes = [...prompt.matchAll(/- ([0-9a-f]{8}|hash\d{4})/g)].map((m) => m[1]);
			return {
				stdout: JSON.stringify({
					cls: "feat",
					bullets: hashes.map((h) => `Improve it. ([${h}](${COMMIT_LINK_BASE}${h}))`),
				}),
				code: 0,
			};
		};
		const draft = await summarizeChangelog(
			{ version: "0.2.0", groups: [{ cls: "feat", heading: "Features", commits: many }] },
			{ spawn: chunkSpawn },
		);
		// 35 commits at 15/chunk → 3 group prompts + 1 overview.
		expect(calls).toHaveLength(4);
		expect(draft?.groups[0].bullets).toHaveLength(35);
		for (const c of many) {
			expect(draft?.groups[0].bullets.join("\n")).toContain(c.hash);
		}
	});

	test("tolerates a ```json fence around a chunk response", async () => {
		const { spawn, calls } = fakeSpawn();
		const fencedSpawn: SpawnFn = async (args, prompt) => {
			calls.push({ args, prompt });
			if (prompt.includes('"overview"')) return { stdout: OVERVIEW_JSON, code: 0 };
			if (prompt.includes("### Features")) {
				return { stdout: "```json\n" + FEAT_GROUP_JSON + "\n```", code: 0 };
			}
			return { stdout: FIX_GROUP_JSON, code: 0 };
		};
		const draft = await summarizeChangelog(INPUT, { spawn: fencedSpawn });
		expect(draft?.overview).toContain("session switching");
		expect(draft?.groups).toHaveLength(2);
	});

	test("collapses model line breaks: one bullet per line with an intact link", async () => {
		const { spawn, calls } = fakeSpawn();
		// JSON.stringify of a string containing real newlines reproduces the
		// `\n` escapes a wrapping model emits inside bullet strings.
		const wrapped = JSON.stringify({
			cls: "feat",
			bullets: [
				"Switch between sessions\nseamlessly. ([a1b2c3d4](https://github.com/nibblebot/omp-web/commit/\na1b2c3d4))",
				"Pick from custom\nthemes. ([e5f6a7b8](https://github.com/nibblebot/omp-web/commit/e5f6a7b8))",
			],
		});
		const wrappedSpawn: SpawnFn = async (args, prompt) => {
			calls.push({ args, prompt });
			if (prompt.includes('"overview"')) return { stdout: OVERVIEW_JSON, code: 0 };
			if (prompt.includes("### Features")) return { stdout: wrapped, code: 0 };
			return { stdout: FIX_GROUP_JSON, code: 0 };
		};
		const draft = await summarizeChangelog(INPUT, { spawn: wrappedSpawn });
		expect(draft?.groups).toHaveLength(2);
		const bullets = draft?.groups.find((g) => g.cls === "feat")?.bullets ?? [];
		expect(bullets).toEqual([
			`Switch between sessions seamlessly. ([a1b2c3d4](${COMMIT_LINK_BASE}a1b2c3d4))`,
			`Pick from custom themes. ([e5f6a7b8](${COMMIT_LINK_BASE}e5f6a7b8))`,
		]);
		expect(bullets.join("\n")).not.toContain("\n\n");
		expect(bullets.join("\n")).not.toContain("commit/ ");
	});

	test("collapses model line breaks in the overview", async () => {
		const { spawn, calls } = fakeSpawn();
		const wrappedOverview = JSON.stringify({
			overview:
				"This release adds session switching\nand custom themes, and fixes the\nidle-timeout crash.",
		});
		const wrappedSpawn: SpawnFn = async (args, prompt) => {
			calls.push({ args, prompt });
			if (prompt.includes('"overview"')) return { stdout: wrappedOverview, code: 0 };
			if (prompt.includes("### Features")) return { stdout: FEAT_GROUP_JSON, code: 0 };
			return { stdout: FIX_GROUP_JSON, code: 0 };
		};
		const draft = await summarizeChangelog(INPUT, { spawn: wrappedSpawn });
		expect(draft?.overview).toBe(OVERVIEW);
		expect(draft?.overview).not.toContain("\n");
	});

	test("maps an empty overview to null (paragraph omitted)", async () => {
		const { spawn } = fakeSpawn({ overviewJson: '{"overview": ""}' });
		const draft = await summarizeChangelog(INPUT, { spawn });
		expect(draft?.overview).toBeNull();
		expect(draft?.groups).toHaveLength(2);
	});

	test("drops a malformed overview but keeps the group bullets", async () => {
		const { spawn } = fakeSpawn({ overviewJson: '{"overview": 42}' });
		const draft = await summarizeChangelog(INPUT, { spawn });
		expect(draft?.overview).toBeNull();
		expect(draft?.groups).toHaveLength(2);
	});

	test("returns null when every spawn exits non-zero", async () => {
		const { spawn, calls } = fakeSpawn({ rejectAll: true });
		expect(await summarizeChangelog(INPUT, { spawn })).toBeNull();
		// Abort after the first failed call — a stuck model stays stuck.
		expect(calls).toHaveLength(1);
	});

	test("returns null for non-JSON output", async () => {
		const { spawn } = fakeSpawn({ groupJson: "definitely not json" });
		expect(await summarizeChangelog(INPUT, { spawn })).toBeNull();
	});

	test("returns null for a group with an unknown commit class", async () => {
		const { spawn } = fakeSpawn({ groupJson: '{"cls": "docs", "bullets": ["x"]}' });
		expect(await summarizeChangelog(INPUT, { spawn })).toBeNull();
	});

	test("returns null for a group with a non-string bullet", async () => {
		const { spawn } = fakeSpawn({ groupJson: '{"cls": "feat", "bullets": [7]}' });
		expect(await summarizeChangelog(INPUT, { spawn })).toBeNull();
	});

	test("returns null for fenced-but-garbage output", async () => {
		const { spawn } = fakeSpawn({ groupJson: "```json\n{ not json\n```" });
		expect(await summarizeChangelog(INPUT, { spawn })).toBeNull();
	});

	test("returns null when the spawn throws", async () => {
		const { spawn, calls } = fakeSpawn({ throwing: true });
		expect(await summarizeChangelog(INPUT, { spawn })).toBeNull();
		expect(calls).toHaveLength(1);
	});

	test("times out a never-resolving spawn and issues only one prompt", async () => {
		const { spawn, calls } = fakeSpawn({ never: true });
		// The 50ms timeout races runTurn directly: summarizeChangelog hardcodes
		// DEFAULT_TIMEOUT_MS, so the short budget cannot go through it.
		expect(await runTurn("hello", undefined, 50, spawn)).toBeNull();
		// Abort after the first call — a stuck model stays stuck.
		expect(calls).toHaveLength(1);
	});

	test("group prompts carry version, hashes, headings, and the output contract", async () => {
		const { spawn, calls } = fakeSpawn();
		await summarizeChangelog(INPUT, { spawn });
		const featPrompt = calls[0].prompt;
		const fixPrompt = calls[1].prompt;
		const overviewPrompt = calls[2].prompt;
		expect(featPrompt).toContain("omp-web 0.2.0");
		expect(featPrompt).toContain("### Features");
		expect(featPrompt).toContain("- a1b2c3d4 add session switching");
		expect(featPrompt).toContain("- e5f6a7b8 support custom themes");
		expect(featPrompt).toContain('"cls"');
		expect(featPrompt).toContain(COMMIT_LINK_BASE);
		expect(featPrompt).toContain("Output ONLY a single JSON object");
		expect(fixPrompt).toContain("### Bug fixes");
		expect(fixPrompt).toContain("- c9d0e1f2 fix idle timeout crash");
		expect(overviewPrompt).toContain('"overview"');
		expect(overviewPrompt).toContain("omp-web 0.2.0");
	});

	test("passes --profile when opts.profile is set, and never when unset", async () => {
		const before = process.env.OMP_WEB_RELEASE_PROFILE;
		delete process.env.OMP_WEB_RELEASE_PROFILE;
		try {
			const { spawn: spawnA, calls: callsA } = fakeSpawn();
			await summarizeChangelog(INPUT, { spawn: spawnA, profile: "work" });
			for (const call of callsA) {
				expect(call.args).toContain("--profile");
				expect(call.args).toContain("work");
			}
			const { spawn: spawnB, calls: callsB } = fakeSpawn();
			await summarizeChangelog(INPUT, { spawn: spawnB });
			expect(callsB).not.toHaveLength(0);
			for (const call of callsB) expect(call.args).not.toContain("--profile");
		} finally {
			if (before === undefined) delete process.env.OMP_WEB_RELEASE_PROFILE;
			else process.env.OMP_WEB_RELEASE_PROFILE = before;
		}
	});
});
