import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import type { SkillsState } from "#lib/wire/protocol";
import { cfgDisabledExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSkillMethods, unwatchSkills, watchSkills } from "../skill-methods";
import type { SessionEntry } from "../session-entry";

afterAll(cleanupTempDirs);

function makeProject(): string {
	const cwd = tempDir("skill-state-cwd-");
	const dir = join(cwd, ".omp", "skills", "demo");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		"---\nname: demo\ndescription: Demo skill for tests.\n---\n\nBody.\n",
	);
	return cwd;
}

function makeEntry(cwd: string): SessionEntry {
	const settings = Settings.isolated({});
	return {
		cwd,
		session: {
			settings,
			skillsSettings: undefined,
			effectiveExtensionRoots: undefined,
			refreshSkillsAndCommands: async () => {},
		},
	} as unknown as SessionEntry;
}

describe("session skill methods", () => {
	test("getSkillsState lists the project skill as enabled", async () => {
		const cwd = makeProject();
		const methods = createSkillMethods();
		const state = (await methods.getSkillsState(makeEntry(cwd), [])) as {
			skills: Array<{ name: string; description: string; enabled: boolean }>;
		};
		expect(state.skills).toContainEqual(
			expect.objectContaining({
				name: "demo",
				description: "Demo skill for tests.",
				enabled: true,
			}),
		);
	});

	test("setSkillEnabled persists the skill:<name> disabledExtensions entry and reverts it", async () => {
		const cwd = makeProject();
		const entry = makeEntry(cwd);
		const methods = createSkillMethods();

		const disabled = (await methods.setSkillEnabled(entry, ["demo", false])) as {
			skills: Array<{ name: string; enabled: boolean }>;
		};
		expect(disabled.skills.find((skill) => skill.name === "demo")?.enabled).toBe(false);
		expect(cfgDisabledExtensions.get(entry.session.settings)).toContain("skill:demo");

		const enabled = (await methods.setSkillEnabled(entry, ["demo", true])) as {
			skills: Array<{ name: string; enabled: boolean }>;
		};
		expect(enabled.skills.find((skill) => skill.name === "demo")?.enabled).toBe(true);
		expect(cfgDisabledExtensions.get(entry.session.settings)).not.toContain("skill:demo");
	});

	test("setSkillEnabled rejects an unknown skill and a non-boolean flag", async () => {
		const cwd = makeProject();
		const entry = makeEntry(cwd);
		const methods = createSkillMethods();
		await expect(methods.setSkillEnabled(entry, ["missing", false])).rejects.toThrow(
			"Unknown skill: missing",
		);
		await expect(methods.setSkillEnabled(entry, ["demo", "no"])).rejects.toThrow(
			"enabled must be a boolean",
		);
	});
});

function addSkill(cwd: string, dirName: string, content: string): void {
	const dir = join(cwd, ".omp", "skills", dirName);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), content);
}

type Detail = {
	name: string;
	description: string;
	enabled: boolean;
	hidden: boolean;
	body: string;
	alwaysApply: boolean;
	globs: string[];
};

describe("session skill methods: getSkillDetail", () => {
	test("returns the body without frontmatter plus alwaysApply and globs", async () => {
		const cwd = makeProject();
		addSkill(
			cwd,
			"rules",
			[
				"---",
				"name: rules",
				"description: Applies to TypeScript.",
				"alwaysApply: true",
				"globs:",
				'  - "*.ts"',
				'  - "src/**"',
				"---",
				"",
				"# Rules",
				"",
				"Use tabs.",
				"",
			].join("\n"),
		);
		const methods = createSkillMethods();
		const detail = (await methods.getSkillDetail(makeEntry(cwd), ["rules"])) as Detail;
		expect(detail).toMatchObject({
			name: "rules",
			description: "Applies to TypeScript.",
			enabled: true,
			hidden: false,
			alwaysApply: true,
			globs: ["*.ts", "src/**"],
		});
		expect(detail.body).toBe("# Rules\n\nUse tabs.");
		expect(detail.body).not.toContain("alwaysApply");
	});

	test("a skill without alwaysApply or globs reports the defaults, and a disabled skill stays readable", async () => {
		const cwd = makeProject();
		const entry = makeEntry(cwd);
		const methods = createSkillMethods();
		await methods.setSkillEnabled(entry, ["demo", false]);
		const detail = (await methods.getSkillDetail(entry, ["demo"])) as Detail;
		expect(detail).toMatchObject({ enabled: false, alwaysApply: false, globs: [], body: "Body." });
	});

	test("a single-string glob becomes a one-item list", async () => {
		const cwd = makeProject();
		addSkill(
			cwd,
			"one-glob",
			"---\nname: one-glob\ndescription: One glob.\nglobs: '**/*.md'\n---\n\nDocs.\n",
		);
		const detail = (await createSkillMethods().getSkillDetail(makeEntry(cwd), [
			"one-glob",
		])) as Detail;
		expect(detail.globs).toEqual(["**/*.md"]);
	});

	test("rejects an unknown skill and a missing name", async () => {
		const methods = createSkillMethods();
		const entry = makeEntry(makeProject());
		await expect(methods.getSkillDetail(entry, ["missing"])).rejects.toThrow(
			"Unknown skill: missing",
		);
		await expect(methods.getSkillDetail(entry, [])).rejects.toThrow("skill name is required");
	});
});

/** Records the order of the listener's side effects and resolves when the inventory frame lands. */
function makeWatcher(entry: SessionEntry) {
	const calls: string[] = [];
	const frames: SkillsState[] = [];
	let notify: () => void = () => {};
	const next = () =>
		new Promise<void>((resolve) => {
			notify = resolve;
		});
	const session = entry.session as unknown as { refreshSkillsAndCommands: () => Promise<void> };
	session.refreshSkillsAndCommands = async () => {
		calls.push("refresh");
	};
	const deps = {
		broadcastAvailableCommands: async () => {
			calls.push("available_commands");
		},
		broadcastSkillsChanged: (_entry: SessionEntry, state: SkillsState) => {
			calls.push("skills_changed");
			frames.push(state);
			notify();
		},
	};
	return { calls, frames, deps, next };
}

describe("session skill methods: disabledExtensions listener", () => {
	test("a web toggle refreshes, then advertises commands, then pushes the new inventory once", async () => {
		const entry = makeEntry(makeProject());
		const { calls, frames, deps, next } = makeWatcher(entry);
		watchSkills(entry, deps);

		const frame = next();
		await createSkillMethods().setSkillEnabled(entry, ["demo", false]);
		await frame;

		expect(calls).toEqual(["refresh", "available_commands", "skills_changed"]);
		expect(frames[0]?.skills.find((skill) => skill.name === "demo")?.enabled).toBe(false);
		unwatchSkills(entry);
	});

	test("an on-disk settings edit reloaded by the SDK pushes skills_changed", async () => {
		const cwd = makeProject();
		const agentDir = tempDir("skill-agent-dir-");
		const settings = await Settings.loadIsolated({ cwd, agentDir });
		const entry = {
			cwd,
			session: {
				settings,
				skillsSettings: undefined,
				effectiveExtensionRoots: undefined,
				refreshSkillsAndCommands: async () => {},
			},
		} as unknown as SessionEntry;
		const { calls, frames, deps, next } = makeWatcher(entry);
		watchSkills(entry, deps);

		writeFileSync(join(agentDir, "config.yml"), "disabledExtensions:\n  - skill:demo\n");
		const frame = next();
		await settings.reloadFromDisk();
		await frame;

		expect(calls).toEqual(["refresh", "available_commands", "skills_changed"]);
		expect(frames[0]?.skills.find((skill) => skill.name === "demo")?.enabled).toBe(false);
		unwatchSkills(entry);
	});

	test("re-wiring an entry (session switch) leaves exactly one live listener", async () => {
		const entry = makeEntry(makeProject());
		const { calls, deps, next } = makeWatcher(entry);
		watchSkills(entry, deps);
		watchSkills(entry, deps);

		const frame = next();
		await createSkillMethods().setSkillEnabled(entry, ["demo", false]);
		await frame;
		// Let any second listener's microtask chain finish before counting.
		await Bun.sleep(20);
		expect(calls.filter((call) => call === "skills_changed")).toHaveLength(1);
		unwatchSkills(entry);
	});

	test("disposal removes the listener: later changes broadcast nothing", async () => {
		const entry = makeEntry(makeProject());
		const { calls, deps } = makeWatcher(entry);
		watchSkills(entry, deps);
		unwatchSkills(entry);

		await createSkillMethods().setSkillEnabled(entry, ["demo", false]);
		await Bun.sleep(20);
		expect(calls).toEqual([]);
		expect(entry.skillsUnlisten).toBeUndefined();
	});
});
