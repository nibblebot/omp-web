import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { SETTING_TABS } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import type { SettingsModel } from "../shared/protocol";
import { createFleetSettings } from "./settings";

// The fleet service reads/writes the shared Settings singleton (values,
// changed flags, condition gates) and lazily initializes it via Settings.init
// on first use. Initialize it in-memory here so tests touch no disk.
await Settings.init({ inMemory: true });

// Every test injects the provider registry: the default source lazily opens
// the REAL agent auth DB (discoverAuthStorage(getAgentDir()) → agent.db),
// which these tests must never touch. The default branch is thin glue over
// the same ModelRegistry code the daemon boots with; the injected and
// degraded paths below cover the contract.
const emptyRegistry = async (): Promise<ReadonlyArray<{ provider: string }>> => [];

function itemsOf(tabId: string, tabs: SettingsModel["tabs"]) {
	return tabs.find((tab) => tab.id === tabId)!.groups.flatMap((group) => group.items);
}

describe("createFleetSettings", () => {
	test("getModel builds every schema tab with populated groups", async () => {
		const settings = createFleetSettings({ registry: emptyRegistry });
		const model = await settings.getModel();
		expect(model.tabs.map((tab) => tab.id)).toEqual(SETTING_TABS);
		for (const tab of model.tabs) {
			expect(tab.label.length).toBeGreaterThan(0);
			expect(tab.groups.length).toBeGreaterThan(0);
			for (const group of tab.groups) {
				expect(group.items.length).toBeGreaterThan(0);
			}
		}
	});

	test("defaultThinkingLevel starts with auto when no session levels exist", async () => {
		const settings = createFleetSettings({ registry: emptyRegistry });
		const model = await settings.getModel();
		const item = itemsOf("model", model.tabs).find((item) => item.path === "defaultThinkingLevel");
		expect(item?.type).toBe("submenu");
		expect(item?.options?.[0]).toEqual({ value: "auto", label: "auto" });
	});

	test("providerLimits lists providers from the injected registry, sorted and de-duplicated", async () => {
		const settings = createFleetSettings({
			registry: async () => [
				{ provider: "openai" },
				{ provider: "anthropic" },
				{ provider: "openai" },
			],
		});
		const model = await settings.getModel();
		const item = itemsOf("providers", model.tabs).find((item) => item.type === "providerLimits");
		expect(item?.providers).toEqual(["anthropic", "openai"]);
	});

	test("providerLimits degrades to an empty list when the registry fails", async () => {
		const settings = createFleetSettings({
			registry: async () => {
				throw new Error("no auth storage");
			},
		});
		const model = await settings.getModel();
		const item = itemsOf("providers", model.tabs).find((item) => item.type === "providerLimits");
		expect(item?.providers).toEqual([]);
	});

	test("set coerces and persists into the Settings singleton, returning a fresh model", async () => {
		const settings = createFleetSettings({ registry: emptyRegistry });
		const model = await settings.set("compaction.thresholdPercent", "50");
		expect(Settings.instance.get("compaction.thresholdPercent")).toBe(50);
		const item = itemsOf("context", model.tabs).find(
			(item) => item.path === "compaction.thresholdPercent",
		);
		expect(item?.value).toBe(50);
		expect(item?.changed).toBe(true);
		// Restore the schema default so the singleton stays pristine for
		// other tests in this file.
		Settings.instance.set("compaction.thresholdPercent", -1);
	});

	test("set rejects unknown paths", async () => {
		const settings = createFleetSettings({ registry: emptyRegistry });
		await expect(settings.set("no.such.path", 1)).rejects.toThrow("Unknown setting: no.such.path");
	});

	test("set rejects uncoercible values", async () => {
		const settings = createFleetSettings({ registry: emptyRegistry });
		await expect(settings.set("compaction.thresholdPercent", "abc")).rejects.toThrow(
			"Invalid numeric value for compaction.thresholdPercent",
		);
	});
});
