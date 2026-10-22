import { describe, expect, test } from "bun:test";
import { imageBlobHash, isUnresolvedImage } from "../../text/images";

describe("unresolved image refs", () => {
	const hash = "0123456789abcdef".repeat(4);

	test("a canonical blob ref yields its hash and counts as unresolved", () => {
		const ref = { data: `blob:sha256:${hash}` };
		expect(imageBlobHash(ref)).toBe(hash);
		expect(isUnresolvedImage(ref)).toBe(true);
	});

	test("base64 data is resolved and has no hash", () => {
		expect(imageBlobHash({ data: "aGVsbG8=" })).toBeUndefined();
		expect(isUnresolvedImage({ data: "aGVsbG8=" })).toBe(false);
	});

	test("a malformed blob ref is never fetched but still renders as a placeholder", () => {
		for (const data of [
			`blob:sha256:${hash.toUpperCase()}`,
			`blob:sha256:${hash}0`,
			"blob:sha256:../x",
		]) {
			expect(imageBlobHash({ data })).toBeUndefined();
			expect(isUnresolvedImage({ data })).toBe(true);
		}
	});
});
