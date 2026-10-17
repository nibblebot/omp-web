import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "#lib/testkit/temp-dir.testkit";
import { cfgDisabledExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSkillMethods } from "../skill-methods";
import type { SessionEntry } from "../session-entry";

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

const deps = { broadcastAvailableCommands: async () => {} };

describe("session skill methods", () => {
	test("getSkillsState lists the project skill as enabled", async () => {
		const cwd = makeProject();
		const methods = createSkillMethods(deps);
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
		const methods = createSkillMethods(deps);

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
		const methods = createSkillMethods(deps);
		await expect(methods.setSkillEnabled(entry, ["missing", false])).rejects.toThrow(
			"Unknown skill: missing",
		);
		await expect(methods.setSkillEnabled(entry, ["demo", "no"])).rejects.toThrow(
			"enabled must be a boolean",
		);
	});
});
