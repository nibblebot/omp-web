import { afterEach, describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { settingsRevision } from "#lib/sdk-settings/settings-model";
import type { SettingsModel } from "#lib/wire/protocol";
import { createSettingsMethods, type SettingsEntry } from "../settings-methods";

// Shared Settings singleton: initialize in memory so the test touches no disk.
await Settings.init({ inMemory: true });

afterEach(() => {
	lookup("compaction.thresholdPercent")!.unset(Settings.instance);
	Settings.instance.clearOverrideValue(lookup("compaction.thresholdPercent")!);
});

const entry: SettingsEntry = {
	session: {
		getAvailableThinkingLevels: () => ["low", "high"],
		getAvailableModels: () => [],
		modelRegistry: { awaitBackgroundRefresh: async () => {} },
	} as unknown as SettingsEntry["session"],
};

describe("settings publish", () => {
	test("a session toggle rebroadcasts the model at the revision the session now holds", async () => {
		const sent: SettingsModel[] = [];
		const bundle = createSettingsMethods({
			settings: Settings.instance,
			getThemes: async () => ["dark", "light"],
			broadcast: (model) => sent.push(model),
		});
		const before = settingsRevision(Settings.instance);
		// A session-side change (fast mode, auto-retry) moves the revision without a settings RPC.
		lookup("compaction.thresholdPercent")!.set(Settings.instance, 80);
		const model = await bundle.publish(entry);
		expect(sent).toEqual([model]);
		expect(model.revision).toBe(settingsRevision(Settings.instance));
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
		expect(ack).toEqual({ revision: settingsRevision(Settings.instance) });
	});

	test("a write at the answered revision is accepted after a rebuild that changed no persisted value", async () => {
		const bundle = createSettingsMethods({
			settings: Settings.instance,
			getThemes: async () => ["dark", "light"],
			broadcast: () => {},
		});
		const ack = (await bundle.methods.setSetting(entry, [
			"compaction.thresholdPercent",
			83,
			undefined,
			undefined,
			"revision",
		])) as { revision: number };
		// Like the config watcher reloading the file this session just wrote: the SDK
		// rebuilds its merged settings (its own counter moves) but persisted content is unchanged.
		const sdkBefore = Settings.instance.revision;
		Settings.instance.writeValue(lookup("compaction.thresholdPercent")!, 84, "override");
		expect(Settings.instance.revision).toBeGreaterThan(sdkBefore);
		await bundle.methods.setSetting(entry, ["compaction.thresholdPercent", 85, ack.revision]);
		expect(Settings.instance.getGlobalSettings().compaction).toMatchObject({
			thresholdPercent: 85,
		});
	});

	test("a write at a revision older than a persisted change is refused", async () => {
		const bundle = createSettingsMethods({
			settings: Settings.instance,
			getThemes: async () => ["dark", "light"],
			broadcast: () => {},
		});
		const stale = settingsRevision(Settings.instance);
		lookup("compaction.thresholdPercent")!.set(Settings.instance, 86);
		await expect(
			bundle.methods.setSetting(entry, ["compaction.thresholdPercent", 87, stale]),
		).rejects.toThrow("Settings changed");
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
