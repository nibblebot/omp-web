import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ImageArg } from "#lib/wire/protocol";
import { createImageUrlCache, imageBlobHash, isUnresolvedImage } from "../../text/images";

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

describe("image object URL cache", () => {
	const image = (text: string, mimeType = "image/png"): ImageArg => ({
		type: "image",
		data: btoa(text),
		mimeType,
	});
	const revoked: string[] = [];
	let revoke: ReturnType<typeof spyOn<typeof URL, "revokeObjectURL">>;

	beforeEach(() => {
		revoked.length = 0;
		revoke = spyOn(URL, "revokeObjectURL").mockImplementation((url) => void revoked.push(url));
	});
	afterEach(() => revoke.mockRestore());

	test("equal payloads in fresh objects share one URL that serves the original bytes", async () => {
		const urlFor = createImageUrlCache(1_000_000, 0);
		const first = urlFor(image("pixels one"));
		expect(urlFor({ ...image("pixels one") })).toBe(first);
		expect(urlFor(image("pixels two"))).not.toBe(first);
		expect(await (await fetch(first)).text()).toBe("pixels one");
	});

	test("an image resolved in place (new data on the same object) gets the URL of its new bytes", async () => {
		const urlFor = createImageUrlCache(1_000_000, 0);
		const img = image("placeholder");
		const first = urlFor(img);
		img.data = btoa("resolved pixels");
		const second = urlFor(img);
		expect(second).not.toBe(first);
		expect(await (await fetch(second)).text()).toBe("resolved pixels");
	});

	test("the same bytes under another mime type get their own URL", () => {
		const urlFor = createImageUrlCache(1_000_000, 0);
		expect(urlFor(image("same", "image/png"))).not.toBe(urlFor(image("same", "image/jpeg")));
	});

	test("past the byte budget the least recently used URL is revoked", async () => {
		const [a, b, c] = ["a".repeat(30), "b".repeat(30), "c".repeat(30)].map((t) => image(t));
		const urlFor = createImageUrlCache(60, 0);
		const urlA = urlFor(a!);
		const urlB = urlFor(b!);
		expect(urlFor(a!)).toBe(urlA); // a is now more recent than b
		urlFor(c!);
		await Bun.sleep(5);
		expect(revoked).toContain(urlB);
		expect(revoked).not.toContain(urlA);
		expect(urlFor(a!)).toBe(urlA);
	});

	test("an undecodable payload falls back to a data: URL and is not cached", () => {
		const urlFor = createImageUrlCache(1_000_000, 0);
		const bad: ImageArg = { type: "image", data: "***not base64***", mimeType: "image/png" };
		expect(urlFor(bad)).toBe("data:image/png;base64,***not base64***");
	});

	test("only raster types become blob: URLs; svg and html stay opaque-origin data: URLs", () => {
		const urlFor = createImageUrlCache(1_000_000, 0);
		const svg = image(
			"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
			"image/svg+xml",
		);
		expect(urlFor(svg)).toBe(`data:image/svg+xml;base64,${svg.data}`);
		const html = image("<script>alert(1)</script>", "text/html");
		expect(urlFor(html)).toBe(`data:text/html;base64,${html.data}`);
		for (const mimeType of [
			"image/png",
			"image/jpeg",
			"image/gif",
			"image/webp",
			"image/avif",
			"image/bmp",
		]) {
			expect(urlFor(image("pixels", mimeType))).toStartWith("blob:");
		}
		expect(urlFor(image("pixels", "IMAGE/PNG; charset=binary"))).toStartWith("blob:");
	});
});
