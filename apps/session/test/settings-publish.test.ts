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
});
