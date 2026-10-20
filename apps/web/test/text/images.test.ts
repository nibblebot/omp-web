import { describe, expect, test } from "bun:test";
import { imageBlobHash, isUnresolvedImage, scanImages } from "../../text/images";

describe("scanImages", () => {
	const img = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };

	test("collects ImageContent blocks at the top level", () => {
		expect(scanImages(img)).toEqual([img]);
	});

	test("walks nested arrays and objects (eval/computer result content)", () => {
		const result = {
			content: [{ type: "text", text: "display image:" }, img],
			details: { cells: [{ outputs: [img, { type: "text", text: "x" }] }] },
		};
		expect(scanImages(result)).toEqual([img, img]);
	});

	test("converts provider screenshot data URLs", () => {
		const shot = { type: "computer_screenshot", image_url: "data:image/png;base64,aGk=" };
		expect(scanImages(shot)).toEqual([{ type: "image", data: "aGk=", mimeType: "image/png" }]);
	});

	test("ignores file-path screenshots (no base64 data)", () => {
		expect(
			scanImages({
				dest: "/tmp/shot.png",
				mimeType: "image/png",
				bytes: 10,
				width: 100,
				height: 50,
			}),
		).toEqual([]);
	});

	test("ignores non-image junk and scalars", () => {
		expect(scanImages(null)).toEqual([]);
		expect(scanImages("hello")).toEqual([]);
		expect(scanImages(42)).toEqual([]);
		expect(scanImages({ type: "text", text: "no" })).toEqual([]);
		expect(scanImages({ type: "image", data: 5, mimeType: "image/png" })).toEqual([]);
	});

	test("keeps the blob references a raw stored transcript carries, in order", () => {
		const ref = {
			type: "image" as const,
			data: `blob:sha256:${"a".repeat(64)}`,
			mimeType: "image/webp",
		};
		expect(scanImages({ content: [ref, img] })).toEqual([ref, img]);
	});
});

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
