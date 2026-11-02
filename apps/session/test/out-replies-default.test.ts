/**
 * `out://` replies in a web session: on while `out.enabled` is unset in every layer (the SDK
 * alone would refuse them, since the web is not a `tuiTranscript`), and any layer that sets the
 * row wins. Writes go through the SDK's own `out://` handler, the gate every reply passes.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { OutProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/out-protocol";
import type { InternalUrl, WriteContext } from "@oh-my-pi/pi-coding-agent/internal-urls/types";
import { cfgOutEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { settingView } from "#lib/sdk-settings/settings-model";
import { pinOutRepliesDefault } from "../out-replies-default";

afterAll(cleanupTempDirs);

const handler = new OutProtocolHandler();
const url = { href: "out://status.md" } as unknown as InternalUrl;

/** The refusal an `out://` write from a session over `settings` gets, or "accepted". */
async function writeReply(settings: Settings, taskDepth = 0): Promise<string> {
	// A web session: the SDK's tuiTranscript option is never passed, so the tool session leaves it off.
	const session = { settings, taskDepth } as unknown as NonNullable<WriteContext["session"]>;
	try {
		await handler.write(url, "**hello**", { session } as WriteContext);
		return "accepted";
	} catch (error) {
		return (error as Error).message;
	}
}

async function webSettings(config?: string) {
	const dir = tempDir("omp-out-replies-");
	if (config !== undefined) writeFileSync(join(dir, "config.yml"), config);
	const settings = await Settings.loadIsolated({ agentDir: dir, cwd: dir });
	return { dir, settings };
}

describe("out:// replies in a web session", () => {
	test("the SDK alone refuses them while the row is unset", async () => {
		const { settings } = await webSettings();
		expect(cfgOutEnabled.isConfigured(settings)).toBe(false);
		expect(await writeReply(settings)).toContain("out:// is off in this session");
	});

	test("unset in every layer, replies are accepted once the session process pins the default", async () => {
		const { dir, settings } = await webSettings();
		pinOutRepliesDefault(settings);
		expect(await writeReply(settings)).toBe("accepted");
		expect(cfgOutEnabled.get(settings)).toBe(true);
		// The pin is a runtime override: nothing reaches config.yml.
		await settings.flush();
		expect(() => readFileSync(join(dir, "config.yml"), "utf8")).toThrow();
	});

	test("an explicit false from config.yml refuses them, an explicit true accepts them", async () => {
		const off = await webSettings("out:\n  enabled: false\n");
		pinOutRepliesDefault(off.settings);
		expect(await writeReply(off.settings)).toContain("out:// is off in this session");
		const on = await webSettings("out:\n  enabled: true\n");
		pinOutRepliesDefault(on.settings);
		expect(await writeReply(on.settings)).toBe("accepted");
	});

	test("a later write to the row is effective live, and an unset falls back to on once re-pinned", async () => {
		const { settings } = await webSettings();
		pinOutRepliesDefault(settings);
		expect(await writeReply(settings)).toBe("accepted");

		cfgOutEnabled.set(settings, false);
		expect(await writeReply(settings)).toContain("out:// is off in this session");
		// Re-asserting the pin never overrides a configured value.
		pinOutRepliesDefault(settings);
		expect(await writeReply(settings)).toContain("out:// is off in this session");

		cfgOutEnabled.set(settings, true);
		expect(await writeReply(settings)).toBe("accepted");

		// Unsetting drops the pin with the value; the settings method re-pins it.
		cfgOutEnabled.unset(settings);
		expect(await writeReply(settings)).toContain("out:// is off in this session");
		pinOutRepliesDefault(settings);
		expect(await writeReply(settings)).toBe("accepted");
	});

	test("a config.yml edit by another process wins over the pin, in either direction", async () => {
		const { dir, settings } = await webSettings();
		pinOutRepliesDefault(settings);
		writeFileSync(join(dir, "config.yml"), "out:\n  enabled: false\n");
		await settings.reloadFromDisk();
		expect(await writeReply(settings)).toContain("out:// is off in this session");
		writeFileSync(join(dir, "config.yml"), "out:\n  enabled: true\n");
		await settings.reloadFromDisk();
		expect(await writeReply(settings)).toBe("accepted");
	});

	test("subagents stay refused, the SDK's rule, even through the pin", async () => {
		const { settings } = await webSettings();
		pinOutRepliesDefault(settings);
		expect(await writeReply(settings, 1)).toContain("Subagents cannot reply");
	});

	test("the Settings sheet shows the row ON from the default, not as a runtime override", async () => {
		const { settings } = await webSettings();
		pinOutRepliesDefault(settings);
		expect(settingView("out.enabled", settings)).toMatchObject({
			effective: true,
			source: "default",
			canUnset: false,
			warnings: [],
		});
		cfgOutEnabled.set(settings, false);
		expect(settingView("out.enabled", settings)).toMatchObject({
			effective: false,
			source: "global",
			canUnset: true,
		});
	});
});
