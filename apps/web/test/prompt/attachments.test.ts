import { describe, expect, test } from "bun:test";
import {
	composeTextAttachments,
	splitTextAttachments,
	importTextAttachment,
	type TextAttachment,
} from "../../prompt/attachments";

describe("importTextAttachment", () => {
	test("reads a text file into an attachment with its content", async () => {
		const file = new File(["const a = 1;\n"], "a.ts", { type: "video/mp2t" });
		const att = await importTextAttachment(file);
		expect(att.name).toBe("a.ts");
		expect(att.size).toBe(file.size);
		expect(att.text).toBe("const a = 1;\n");
		expect(att.error).toBeUndefined();
	});

	test("oversize file becomes an error chip without text", async () => {
		const file = new File(["x".repeat(1_000_001)], "big.txt", { type: "text/plain" });
		const att = await importTextAttachment(file);
		expect(att.text).toBeUndefined();
		expect(att.error).toBe('"big.txt" is too large (over ~1MB).');
	});

	test("binary file becomes an error chip", async () => {
		const file = new File([new Uint8Array([0, 1, 2])], "app.exe", {
			type: "application/octet-stream",
		});
		const att = await importTextAttachment(file);
		expect(att.text).toBeUndefined();
		expect(att.error).toBe('"app.exe" is not a text file the composer accepts.');
	});

	test("empty file becomes an error chip", async () => {
		const att = await importTextAttachment(new File([], "empty.md", { type: "text/markdown" }));
		expect(att.text).toBeUndefined();
		expect(att.error).toBe('"empty.md" is empty.');
	});

	test("each attachment gets a distinct id", async () => {
		const a = await importTextAttachment(new File(["1"], "a.txt", { type: "text/plain" }));
		const b = await importTextAttachment(new File(["2"], "b.txt", { type: "text/plain" }));
		expect(a.id).not.toBe(b.id);
	});
});

describe("composeTextAttachments", () => {
	const ok = (name: string, text: string): TextAttachment => ({
		id: name,
		name,
		size: text.length,
		text,
	});

	test("returns the typed text unchanged when nothing is attached", () => {
		expect(composeTextAttachments("hello", [])).toBe("hello");
	});

	test("appends each readable file as a <file> block after the typed text", () => {
		const out = composeTextAttachments("review this", [ok("a.ts", "line1\nline2")]);
		expect(out).toBe('review this\n\n<file path="a.ts">\nline1\nline2\n</file>');
	});

	test("skips error chips", () => {
		const bad: TextAttachment = { id: "x", name: "big.txt", size: 9, error: "too large" };
		expect(composeTextAttachments("hi", [bad, ok("a.ts", "A")])).toBe(
			'hi\n\n<file path="a.ts">\nA\n</file>',
		);
	});

	test("sends only the file blocks when the typed text is empty", () => {
		expect(composeTextAttachments("", [ok("a.ts", "A")])).toBe('<file path="a.ts">\nA\n</file>');
	});

	test("escapes characters in the path so a file name cannot close the tag", () => {
		const out = composeTextAttachments("", [ok('a"&<b.ts', "X")]);
		expect(out).toBe('<file path="a&quot;&amp;&lt;b.ts">\nX\n</file>');
	});
});

describe("splitTextAttachments", () => {
	test("lifts composed file blocks back out and keeps the typed text exact", () => {
		const files: TextAttachment[] = [
			{ id: "1", name: 'a"&<b.ts', size: 11, text: "line1\nline2" },
			{ id: "2", name: "b.md", size: 3, text: "# B" },
		];
		const composed = composeTextAttachments("review\n\nthis", files);
		expect(splitTextAttachments(composed)).toEqual({
			text: "review\n\nthis",
			files: [
				expect.objectContaining({ name: 'a"&<b.ts', text: "line1\nline2", size: 11 }),
				expect.objectContaining({ name: "b.md", text: "# B", size: 3 }),
			],
		});
	});

	test("restores a message that is only files to an empty text", () => {
		const composed = composeTextAttachments("", [{ id: "1", name: "a.ts", size: 1, text: "A" }]);
		expect(splitTextAttachments(composed)).toEqual({
			text: "",
			files: [expect.objectContaining({ name: "a.ts", text: "A" })],
		});
	});

	test("leaves a message without file blocks untouched", () => {
		expect(splitTextAttachments("plain <file> text")).toEqual({
			text: "plain <file> text",
			files: [],
		});
	});
});
