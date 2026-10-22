import { describe, expect, test } from "bun:test";
import { scanImages } from "../tool-result";

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
