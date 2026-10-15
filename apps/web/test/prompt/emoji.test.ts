import { describe, expect, test } from "bun:test";
import {
	getEmojiSuggestions,
	tryEmojiInlineReplace,
} from "@oh-my-pi/pi-tui/prompt/emoji-autocomplete";
import type * as EmojiModule from "../../prompt/emoji";
import { emojiInlineReplace, emojiSuggestions, ensureEmojiTable } from "../../prompt/emoji";

const PARITY_INPUTS = [
	":joy",
	":",
	"note:",
	":smile:",
	":D",
	";) ",
	":-) ",
	"a:b",
	"(:tada",
	":PATH",
	"",
	":xyzzyq",
	":joy:",
	":+1:",
	"x:D",
	"</3 ",
	":'-( ",
	"hi :p ",
	"[:fire:",
];

describe("emoji parity with SDK", () => {
	test("suggestions match the SDK for every input", async () => {
		await ensureEmojiTable();
		for (const input of PARITY_INPUTS) {
			const sdk = getEmojiSuggestions(input);
			const ours = emojiSuggestions(input);
			if (sdk === null) {
				expect(ours).toBeNull();
				continue;
			}
			expect(ours).not.toBeNull();
			expect(ours!.prefix).toBe(sdk.prefix);
			expect(ours!.items).toEqual(
				sdk.items.map((item) => ({ emoji: item.value, label: item.label })),
			);
		}
	});

	test("inline replace matches the SDK for every input", async () => {
		await ensureEmojiTable();
		for (const input of PARITY_INPUTS) {
			expect(emojiInlineReplace(input)).toEqual(tryEmojiInlineReplace(input));
		}
	});

	test("suggestions are capped at 12", async () => {
		await ensureEmojiTable();
		const result = emojiSuggestions(":a");
		expect(result).not.toBeNull();
		expect(result!.items.length).toBeLessThanOrEqual(12);
	});

	test("emoticons come first for a bare :D prefix", async () => {
		await ensureEmojiTable();
		const result = emojiSuggestions(":D");
		expect(result?.items[0]).toEqual({ emoji: "😃", label: "😃  :D" });
	});
});

describe("emoji lazy contract", () => {
	async function freshModule(): Promise<typeof EmojiModule> {
		return (await import(
			`../../prompt/emoji.ts?fresh=${Date.now()}-${Math.random()}`
		)) as typeof EmojiModule;
	}

	test("shortcode results are null before the table loads", async () => {
		const fresh = await freshModule();
		expect(fresh.emojiSuggestions(":joy")).toBeNull();
		expect(fresh.emojiInlineReplace(":joy:")).toBeNull();
	});

	test("emoticon inline replace works before the table loads", async () => {
		const fresh = await freshModule();
		expect(fresh.emojiInlineReplace(";) ")).toEqual({ replaceLen: 3, insert: "😉 " });
	});

	test("shortcode results become non-null after ensureEmojiTable", async () => {
		const fresh = await freshModule();
		await fresh.ensureEmojiTable();
		expect(fresh.emojiSuggestions(":joy")).not.toBeNull();
		expect(fresh.emojiInlineReplace(":joy:")).toEqual({ replaceLen: 5, insert: "😂" });
	});

	test("ensureEmojiTable is idempotent and returns the same promise", async () => {
		const fresh = await freshModule();
		const first = fresh.ensureEmojiTable();
		const second = fresh.ensureEmojiTable();
		expect(second).toBe(first);
		await Promise.all([first, second]);
		expect(fresh.emojiSuggestions(":joy")).not.toBeNull();
	});
});
