import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sha256Hex } from "../../text/sha256";

const nodeHex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

describe("sha256Hex", () => {
	test("matches the published vectors", () => {
		expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
		expect(sha256Hex("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});

	test("matches node across block boundaries and multi-byte UTF-8", () => {
		for (const text of [
			"x".repeat(55),
			"x".repeat(56),
			"x".repeat(64),
			"x".repeat(1000),
			"héllo €𝄞 ✓\n\tdiff --git a/b c",
		]) {
			expect(sha256Hex(text)).toBe(nodeHex(text));
		}
	});
});
