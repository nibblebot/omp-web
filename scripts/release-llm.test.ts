/**
 * Unit tests for scripts/release-llm.ts. The LLM path is exercised purely
 * through the sessionFactory seam — no real SDK import, no network, no auth.
 *
 * The summarizer prompts once per bounded chunk of commits plus once for the
 * overview, so the fake session routes responses by prompt content:
 * - group prompts contain `### <heading>` and the `"cls"` output contract;
 * - the overview prompt contains the `"overview"` output contract.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeChangelog } from "./release-llm";
import type { SummarizeInput } from "./release-llm";

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

interface FactoryOptions {
	/** Response for group-chunk prompts; routed by heading. */
	groupJson?: string;
	/** Response for the overview prompt. */
	overviewJson?: string;
	rejectAll?: boolean;
	never?: boolean;
	throwOnCreate?: boolean;
	onPrompt?: (text: string) => void;
}

/** Fake sessionFactory seam: records prompts/deps/destroys, no SDK involved. */
function fakeFactory(opts: FactoryOptions = {}) {
	const captured: { prompts: string[]; deps: unknown; destroyed: number } = {
		prompts: [],
		deps: null,
		destroyed: 0,
	};
	const factory = async (deps: unknown) => {
		captured.deps = deps;
		if (opts.throwOnCreate) throw new Error("bootstrap failed");
		const session = {
			prompt: async (text: string) => {
				captured.prompts.push(text);
				opts.onPrompt?.(text);
				if (opts.never) return await new Promise<never>(() => {});
				if (opts.rejectAll) throw new Error("model call failed");
				if (text.includes('"overview"')) return opts.overviewJson ?? OVERVIEW_JSON;
				if (text.includes("### Features")) return opts.groupJson ?? FEAT_GROUP_JSON;
				return opts.groupJson ?? FIX_GROUP_JSON;
			},
			destroy: () => {
				captured.destroyed++;
			},
		};
		return { session };
	};
	return { factory, captured };
}

function depsOf(captured: { deps: unknown }): Record<string, unknown> {
	expect(captured.deps).not.toBeNull();
	return captured.deps as Record<string, unknown>;
}

describe("summarizeChangelog with a fake sessionFactory", () => {
	test("resolves a valid draft: one prompt per chunk plus the overview", async () => {
		const { factory, captured } = fakeFactory();
		const draft = await summarizeChangelog(INPUT, { sessionFactory: factory });
		expect(draft).not.toBeNull();
		expect(draft?.overview).toBe(OVERVIEW);
		expect(draft?.groups).toEqual([
			{ cls: "feat", bullets: JSON.parse(FEAT_GROUP_JSON).bullets },
			{ cls: "fix", bullets: JSON.parse(FIX_GROUP_JSON).bullets },
		]);
		// 2 group chunks + 1 overview turn; one session, destroyed once at the end.
		expect(captured.prompts).toHaveLength(3);
		expect(captured.destroyed).toBe(1);
	});

	test("chunks a group larger than the chunk size into multiple prompts", async () => {
		const many = Array.from({ length: 35 }, (_, i) => ({
			hash: `hash${i.toString().padStart(4, "0")}`,
			subject: `commit number ${i}`,
		}));
		const { captured } = fakeFactory();
		// Replace routing: answer each group prompt with bullets built from the
		// hashes present in that prompt.
		const realFactory = async (deps: unknown) => {
			captured.deps = deps;
			const session = {
				prompt: async (text: string) => {
					captured.prompts.push(text);
					if (text.includes('"overview"')) return OVERVIEW_JSON;
					const hashes = [...text.matchAll(/- ([0-9a-f]{8}|hash\d{4})/g)].map((m) => m[1]);
					return JSON.stringify({
						cls: "feat",
						bullets: hashes.map((h) => `Improve it. ([${h}](${COMMIT_LINK_BASE}${h}))`),
					});
				},
				destroy: () => {
					captured.destroyed++;
				},
			};
			return { session };
		};
		const draft = await summarizeChangelog(
			{ version: "0.2.0", groups: [{ cls: "feat", heading: "Features", commits: many }] },
			{ sessionFactory: realFactory },
		);
		// 35 commits at 15/chunk → 3 group prompts + 1 overview.
		expect(captured.prompts).toHaveLength(4);
		expect(draft?.groups[0].bullets).toHaveLength(35);
		for (const c of many) {
			expect(draft?.groups[0].bullets.join("\n")).toContain(c.hash);
		}
	});

	test("tolerates a ```json fence around a chunk response", async () => {
		const { captured } = fakeFactory();
		const realFactory = async (deps: unknown) => {
			const session = {
				prompt: async (text: string) => {
					captured.prompts.push(text);
					if (text.includes('"overview"')) return OVERVIEW_JSON;
					if (text.includes("### Features")) return "```json\n" + FEAT_GROUP_JSON + "\n```";
					return FIX_GROUP_JSON;
				},
				destroy: () => {
					captured.destroyed++;
				},
			};
			return { session };
		};
		const draft = await summarizeChangelog(INPUT, { sessionFactory: realFactory });
		expect(draft?.overview).toContain("session switching");
		expect(draft?.groups).toHaveLength(2);
	});

	test("maps an empty overview to null (paragraph omitted)", async () => {
		const { factory } = fakeFactory({ overviewJson: '{"overview": ""}' });
		const draft = await summarizeChangelog(INPUT, { sessionFactory: factory });
		expect(draft?.overview).toBeNull();
		expect(draft?.groups).toHaveLength(2);
	});

	test("drops a malformed overview but keeps the group bullets", async () => {
		const { factory } = fakeFactory({ overviewJson: '{"overview": 42}' });
		const draft = await summarizeChangelog(INPUT, { sessionFactory: factory });
		expect(draft?.overview).toBeNull();
		expect(draft?.groups).toHaveLength(2);
	});

	test("returns null when every prompt rejects", async () => {
		const { factory, captured } = fakeFactory({ rejectAll: true });
		expect(await summarizeChangelog(INPUT, { sessionFactory: factory })).toBeNull();
		expect(captured.destroyed).toBe(1);
	});

	test("returns null for non-JSON output", async () => {
		const { factory } = fakeFactory({ groupJson: "definitely not json" });
		expect(await summarizeChangelog(INPUT, { sessionFactory: factory })).toBeNull();
	});

	test("returns null for a group with an unknown commit class", async () => {
		const { factory } = fakeFactory({ groupJson: '{"cls": "docs", "bullets": ["x"]}' });
		expect(await summarizeChangelog(INPUT, { sessionFactory: factory })).toBeNull();
	});

	test("returns null for a group with a non-string bullet", async () => {
		const { factory } = fakeFactory({ groupJson: '{"cls": "feat", "bullets": [7]}' });
		expect(await summarizeChangelog(INPUT, { sessionFactory: factory })).toBeNull();
	});

	test("returns null for fenced-but-garbage output", async () => {
		const { factory } = fakeFactory({ groupJson: "```json\n{ not json\n```" });
		expect(await summarizeChangelog(INPUT, { sessionFactory: factory })).toBeNull();
	});

	test("returns null when the sessionFactory throws", async () => {
		const { factory } = fakeFactory({ throwOnCreate: true });
		expect(await summarizeChangelog(INPUT, { sessionFactory: factory })).toBeNull();
	});

	test("returns null when the factory result is not a session", async () => {
		const factory = async () => ({ nope: true });
		expect(await summarizeChangelog(INPUT, { sessionFactory: factory })).toBeNull();
	});

	test("times out a never-resolving prompt, aborts, and destroys the session", async () => {
		const { factory, captured } = fakeFactory({ never: true });
		expect(await summarizeChangelog(INPUT, { sessionFactory: factory, timeoutMs: 50 })).toBeNull();
		// Abort after the first chunk timeout — a stuck model stays stuck.
		expect(captured.prompts).toHaveLength(1);
		expect(captured.destroyed).toBe(1);
	});

	test("group prompts carry version, hashes, headings, and the output contract", async () => {
		const { factory, captured } = fakeFactory();
		await summarizeChangelog(INPUT, { sessionFactory: factory });
		const featPrompt = captured.prompts[0];
		const fixPrompt = captured.prompts[1];
		const overviewPrompt = captured.prompts[2];
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

	test("hands the factory the full bootstrap deps object", async () => {
		const { factory, captured } = fakeFactory();
		await summarizeChangelog(INPUT, { sessionFactory: factory, agentDir: "/opt/test-agent" });
		const deps = depsOf(captured);
		for (const key of [
			"cwd",
			"agentDir",
			"authStorage",
			"modelRegistry",
			"settings",
			"sessionManager",
			"agentRegistry",
			"eventBus",
		]) {
			expect(key in deps).toBe(true);
		}
		expect(deps.agentDir).toBe("/opt/test-agent");
		expect(typeof deps.cwd).toBe("string");
		expect((deps.cwd as string).startsWith(tmpdir())).toBe(true);
	});

	test("cleans up the scratch cwd after the call", async () => {
		const { factory, captured } = fakeFactory();
		await summarizeChangelog(INPUT, { sessionFactory: factory });
		const deps = depsOf(captured);
		const cwd = deps.cwd as string;
		expect(existsSync(cwd)).toBe(false);
	});
});
