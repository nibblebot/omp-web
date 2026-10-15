import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import {
	cfgComposerPredictions,
	cfgSpellingAutocomplete,
} from "@oh-my-pi/pi-coding-agent/modes/settings";
import { createComposerMethods } from "../composer-methods";
import type { SessionEntry } from "../session-entry";

function entryWith(settings: Settings): SessionEntry {
	return { session: { settings } } as unknown as SessionEntry;
}

describe("composer ghost-text RPC argument checks", () => {
	test("predictWord rejects a cursor past the end of the text", async () => {
		const settings = Settings.isolated();
		const methods = createComposerMethods();
		await expect(methods.predictWord!(entryWith(settings), ["abc", 9])).rejects.toThrow(
			"cursor must be an integer UTF-16 offset within text",
		);
	});

	test("predictWord rejects a non-integer cursor", async () => {
		const settings = Settings.isolated();
		const methods = createComposerMethods();
		await expect(methods.predictWord!(entryWith(settings), ["abc", 1.5])).rejects.toThrow(
			"cursor must be an integer UTF-16 offset within text",
		);
	});

	test("predictWordFeedback rejects a non-boolean accepted flag", async () => {
		const settings = Settings.isolated();
		const methods = createComposerMethods();
		await expect(
			methods.predictWordFeedback!(entryWith(settings), ["abc", 3, "d", "yes"]),
		).rejects.toThrow("suggestion must be a string and accepted a boolean");
	});
});

describe("composer ghost-text RPC gating", () => {
	test("predictWordFeedback is a no-op when spelling.autocomplete is off", async () => {
		const settings = Settings.isolated();
		cfgSpellingAutocomplete.set(settings, "off");
		const methods = createComposerMethods();
		expect(await methods.predictWordFeedback!(entryWith(settings), ["abc", 3, "d", true])).toEqual(
			{},
		);
	});

	test("predictNextMessage answers null while composer.predictions is off (default)", async () => {
		const settings = Settings.isolated();
		const methods = createComposerMethods();
		expect(await methods.predictNextMessage!(entryWith(settings), [])).toEqual({ text: null });
	});

	test("predictNextMessage answers null without a model even when enabled", async () => {
		const settings = Settings.isolated();
		cfgComposerPredictions.set(settings, true);
		const methods = createComposerMethods();
		const entry = {
			session: { settings, model: undefined, isStreaming: false, isCompacting: false },
		};
		expect(await methods.predictNextMessage!(entry as unknown as SessionEntry, [])).toEqual({
			text: null,
		});
	});
});
