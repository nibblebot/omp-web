import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { SETTING_TABS } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import type { SettingsModel } from "#lib/wire/protocol";
import { createFleetSettings } from "../settings";

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
	test("getModel builds every schema tab in schema order", async () => {
		const settings = createFleetSettings({ registry: emptyRegistry });
		const model = await settings.getModel();
		expect(model.tabs.map((tab) => tab.id)).toEqual(SETTING_TABS);
	});

	test("defaultThinkingLevel offers the schema's levels with auto first when no session levels exist", async () => {
		const settings = createFleetSettings({ registry: emptyRegistry });
		const model = await settings.getModel();
		const item = itemsOf("model", model.tabs).find((item) => item.path === "defaultThinkingLevel");
		expect(item?.type).toBe("submenu");
		expect(item?.options?.[0]?.value).toBe("auto");
		const values = item?.options?.map((option) => option.value) ?? [];
		expect(values).toContain("minimal");
		expect(values).toContain("max");
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

	test("a failed provider read is not cached: the next settings request retries", async () => {
		let calls = 0;
		const settings = createFleetSettings({
			registry: async () => {
				calls += 1;
				if (calls === 1) throw new Error("registry not ready");
				return [{ provider: "openai" }];
			},
		});
		const first = await settings.getModel();
		expect(
			itemsOf("providers", first.tabs).find((item) => item.type === "providerLimits")?.providers,
		).toEqual([]);
		const second = await settings.getModel();
		expect(
			itemsOf("providers", second.tabs).find((item) => item.type === "providerLimits")?.providers,
		).toEqual(["openai"]);
		expect(calls).toBe(2);
	});

	test("a successful provider list is reused within providerCacheMs", async () => {
		let calls = 0;
		const settings = createFleetSettings({
			providerCacheMs: 60_000,
			registry: async () => {
				calls += 1;
				return [{ provider: "anthropic" }];
			},
		});
		await settings.getModel();
		await settings.getModel();
		expect(calls).toBe(1);
	});

	test("a successful provider list is re-read once providerCacheMs has elapsed", async () => {
		let providers = ["anthropic"];
		const settings = createFleetSettings({
			providerCacheMs: 0,
			registry: async () => providers.map((provider) => ({ provider })),
		});
		await settings.getModel();
		providers = ["anthropic", "openai"];
		const model = await settings.getModel();
		expect(
			itemsOf("providers", model.tabs).find((item) => item.type === "providerLimits")?.providers,
		).toEqual(["anthropic", "openai"]);
	});

	test("set coerces and persists into the Settings singleton, returning a fresh model", async () => {
		const settings = createFleetSettings({ registry: emptyRegistry });
		const model = await settings.set("compaction.thresholdPercent", "50");
		expect(lookup("compaction.thresholdPercent")!.get(Settings.instance)).toBe(50);
		const item = itemsOf("context", model.tabs).find(
			(item) => item.path === "compaction.thresholdPercent",
		);
		expect(item?.value).toBe(50);
		expect(item?.changed).toBe(true);
		// Restore the schema default so the singleton stays pristine for
		// other tests in this file.
		lookup("compaction.thresholdPercent")!.set(Settings.instance, -1);
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
