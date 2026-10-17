import { afterEach, describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import type { SettingsModel } from "#lib/wire/protocol";
import { createSettingsMethods, type SettingsEntry } from "../settings-methods";

// Shared Settings singleton: initialize in memory so the test touches no disk.
await Settings.init({ inMemory: true });

afterEach(() => {
	lookup("compaction.thresholdPercent")!.unset(Settings.instance);
});

const entry: SettingsEntry = {
	session: {
		getAvailableThinkingLevels: () => ["low", "high"],
		getAvailableModels: () => [],
		modelRegistry: { awaitBackgroundRefresh: async () => {} },
	} as unknown as SettingsEntry["session"],
};

describe("settings publish", () => {
	test("a session toggle rebroadcasts the model at the revision the daemon now holds", async () => {
		const sent: SettingsModel[] = [];
		const bundle = createSettingsMethods({
			settings: Settings.instance,
			getThemes: async () => ["dark", "light"],
			broadcast: (model) => sent.push(model),
		});
		const before = Settings.instance.revision;
		// A session-side change (fast mode, auto-retry) moves the revision without a settings RPC.
		lookup("compaction.thresholdPercent")!.set(Settings.instance, 80);
		const model = await bundle.publish(entry);
		expect(sent).toEqual([model]);
		expect(model.revision).toBe(Settings.instance.revision);
		expect(model.revision).toBeGreaterThan(before);
	});

	test("a revision reply answers with the revision and broadcasts the model once", async () => {
		const sent: SettingsModel[] = [];
		const bundle = createSettingsMethods({
			settings: Settings.instance,
			getThemes: async () => ["dark", "light"],
			broadcast: (model) => sent.push(model),
		});
		const ack = await bundle.methods.setSetting(entry, [
			"compaction.thresholdPercent",
			81,
			undefined,
			undefined,
			"revision",
		]);
		expect(sent).toHaveLength(1);
		expect(ack).toEqual({ revision: Settings.instance.revision });
	});

	test("a write without the reply option keeps answering with the full model", async () => {
		const sent: SettingsModel[] = [];
		const bundle = createSettingsMethods({
			settings: Settings.instance,
			getThemes: async () => ["dark", "light"],
			broadcast: (model) => sent.push(model),
		});
		const answer = await bundle.methods.setSetting(entry, [
			"compaction.thresholdPercent",
			82,
			undefined,
			undefined,
		]);
		expect(sent).toHaveLength(1);
		expect(answer).toEqual(sent[0]!);
	});
});
