/**
 * Unit tests for scripts/release-llm.ts. The LLM path is exercised purely
 * through the sessionFactory seam — no real SDK import, no network, no auth.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

const VALID_JSON = JSON.stringify({
	overview: OVERVIEW,
	groups: [
		{
			cls: "feat",
			bullets: [
				`Switch between sessions seamlessly. ([a1b2c3d4](${COMMIT_LINK_BASE}a1b2c3d4))`,
				`Pick from custom themes. ([e5f6a7b8](${COMMIT_LINK_BASE}e5f6a7b8))`,
			],
		},
		{
			cls: "fix",
			bullets: [`Fix a crash on idle timeout. ([c9d0e1f2](${COMMIT_LINK_BASE}c9d0e1f2))`],
		},
	],
});

interface FactoryOptions {
	result?: unknown;
	reject?: boolean;
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
				if (opts.reject) throw new Error("model call failed");
				return opts.result;
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
	test("resolves a valid JSON draft", async () => {
		const { factory, captured } = fakeFactory({ result: VALID_JSON });
		const draft = await summarizeChangelog(INPUT, { sessionFactory: factory });
		expect(draft).not.toBeNull();
		expect(draft?.overview).toBe(OVERVIEW);
		expect(draft?.groups).toEqual([
			{
				cls: "feat",
				bullets: [
					`Switch between sessions seamlessly. ([a1b2c3d4](${COMMIT_LINK_BASE}a1b2c3d4))`,
					`Pick from custom themes. ([e5f6a7b8](${COMMIT_LINK_BASE}e5f6a7b8))`,
				],
			},
			{
				cls: "fix",
				bullets: [`Fix a crash on idle timeout. ([c9d0e1f2](${COMMIT_LINK_BASE}c9d0e1f2))`],
			},
		]);
		expect(captured.destroyed).toBe(1);
	});

	test("tolerates a ```json fence around the draft", async () => {
		const { factory } = fakeFactory({ result: "```json\n" + VALID_JSON + "\n```" });
		const draft = await summarizeChangelog(INPUT, { sessionFactory: factory });
		expect(draft?.overview).toContain("session switching");
		expect(draft?.groups).toHaveLength(2);
	});

	test("maps an empty overview to null (paragraph omitted)", async () => {
		const json = JSON.stringify({ overview: "", groups: [] });
		const { factory } = fakeFactory({ result: json });
		const draft = await summarizeChangelog(INPUT, { sessionFactory: factory });
		expect(draft).toEqual({ overview: null, groups: [] });
	});

	test("returns null when the prompt rejects", async () => {
		const { factory, captured } = fakeFactory({ reject: true });
		expect(await summarizeChangelog(INPUT, { sessionFactory: factory })).toBeNull();
		expect(captured.destroyed).toBe(1);
	});

	test("returns null for non-JSON output", async () => {
		const { factory } = fakeFactory({ result: "definitely not json" });
		expect(await summarizeChangelog(INPUT, { sessionFactory: factory })).toBeNull();
	});

	test("returns null for an invalid shape (non-string overview)", async () => {
		const { factory } = fakeFactory({ result: JSON.stringify({ overview: 42, groups: [] }) });
		expect(await summarizeChangelog(INPUT, { sessionFactory: factory })).toBeNull();
	});

	test("returns null for an unknown commit class", async () => {
		const json = JSON.stringify({ overview: "oops", groups: [{ cls: "docs", bullets: ["x"] }] });
		const { factory } = fakeFactory({ result: json });
		expect(await summarizeChangelog(INPUT, { sessionFactory: factory })).toBeNull();
	});

	test("returns null for a non-string bullet", async () => {
		const json = JSON.stringify({ overview: "oops", groups: [{ cls: "feat", bullets: [7] }] });
		const { factory } = fakeFactory({ result: json });
		expect(await summarizeChangelog(INPUT, { sessionFactory: factory })).toBeNull();
	});

	test("returns null for fenced-but-garbage output", async () => {
		const { factory } = fakeFactory({ result: "```json\n{ not json\n```" });
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

	test("times out a never-resolving prompt and destroys the session", async () => {
		const { factory, captured } = fakeFactory({ never: true });
		expect(await summarizeChangelog(INPUT, { sessionFactory: factory, timeoutMs: 50 })).toBeNull();
		expect(captured.destroyed).toBe(1);
	});

	test("passes the full prompt: version, every hash, output contract", async () => {
		let promptText = "";
		const { factory } = fakeFactory({
			result: VALID_JSON,
			onPrompt: (text) => {
				promptText = text;
			},
		});
		await summarizeChangelog(INPUT, { sessionFactory: factory });
		expect(promptText).toContain("omp-web 0.2.0");
		expect(promptText).toContain("a1b2c3d4");
		expect(promptText).toContain("e5f6a7b8");
		expect(promptText).toContain("c9d0e1f2");
		expect(promptText).toContain("### Features");
		expect(promptText).toContain("- a1b2c3d4 add session switching");
		expect(promptText).toContain("### Bug fixes");
		expect(promptText).toContain('"cls"');
		expect(promptText).toContain(COMMIT_LINK_BASE);
		expect(promptText).toContain("Output ONLY a single JSON object");
	});

	test("hands the factory the full bootstrap deps object", async () => {
		const { factory, captured } = fakeFactory({ result: VALID_JSON });
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
		const { factory, captured } = fakeFactory({ result: VALID_JSON });
		await summarizeChangelog(INPUT, { sessionFactory: factory });
		const cwd = depsOf(captured).cwd as string;
		expect(cwd.length).toBeGreaterThan(0);
		expect(existsSync(cwd)).toBe(false);
	});

	test("defaults agentDir to ~/.omp/agent", async () => {
		const savedPi = process.env.PI_CODING_AGENT_DIR;
		const savedWeb = process.env.OMP_WEB_RELEASE_AGENT_DIR;
		delete process.env.PI_CODING_AGENT_DIR;
		delete process.env.OMP_WEB_RELEASE_AGENT_DIR;
		try {
			const { factory, captured } = fakeFactory({ result: VALID_JSON });
			await summarizeChangelog(INPUT, { sessionFactory: factory });
			expect(depsOf(captured).agentDir).toBe(join(homedir(), ".omp", "agent"));
		} finally {
			if (savedPi === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = savedPi;
			if (savedWeb === undefined) delete process.env.OMP_WEB_RELEASE_AGENT_DIR;
			else process.env.OMP_WEB_RELEASE_AGENT_DIR = savedWeb;
		}
	});

	test("honors OMP_WEB_RELEASE_AGENT_DIR before the daemon default", async () => {
		const saved = process.env.OMP_WEB_RELEASE_AGENT_DIR;
		process.env.OMP_WEB_RELEASE_AGENT_DIR = "/tmp/hermetic-agent";
		try {
			const { factory, captured } = fakeFactory({ result: VALID_JSON });
			await summarizeChangelog(INPUT, { sessionFactory: factory });
			expect(depsOf(captured).agentDir).toBe("/tmp/hermetic-agent");
		} finally {
			if (saved === undefined) delete process.env.OMP_WEB_RELEASE_AGENT_DIR;
			else process.env.OMP_WEB_RELEASE_AGENT_DIR = saved;
		}
	});

	test("expands a tilde in PI_CODING_AGENT_DIR", async () => {
		const saved = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = "~/custom-agent";
		try {
			const { factory, captured } = fakeFactory({ result: VALID_JSON });
			await summarizeChangelog(INPUT, { sessionFactory: factory });
			expect(depsOf(captured).agentDir).toBe(join(homedir(), "custom-agent"));
		} finally {
			if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = saved;
		}
	});
});
