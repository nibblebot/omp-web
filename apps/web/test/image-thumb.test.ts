/**
 * An image whose data is still a `blob:sha256:` reference (a subagent transcript image that is loading,
 * too large, or gone) renders an `[image]` chip, never an <img> the browser cannot decode.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import * as solidWeb from "solid-js/web";
import type { ImageArg } from "#lib/wire/protocol";
import { ImageThumb } from "../components/ui/ImageThumb";
import { installJsxShim, restoreJsxShim } from "./web.testkit";

beforeAll(() => {
	installJsxShim();
});

afterAll(() => {
	restoreJsxShim();
});

function render(image: ImageArg): string {
	return solidWeb.renderToString(() =>
		createComponent(ImageThumb, { image, alt: "shot", onZoom: () => {} }),
	);
}

describe("ImageThumb", () => {
	test("a blob ref renders the [image] chip and no <img>", () => {
		const html = render({
			type: "image",
			data: `blob:sha256:${"a".repeat(64)}`,
			mimeType: "image/png",
		});
		expect(html).toContain("img-pending");
		expect(html).toContain("[image]");
		expect(html).not.toContain("<img");
		expect(html).not.toContain("<button");
	});

	test("a malformed blob ref also renders the chip", () => {
		const html = render({ type: "image", data: "blob:sha256:../x", mimeType: "image/png" });
		expect(html).toContain("[image]");
		expect(html).not.toContain("<img");
	});

	test("decodable data renders the zoom thumbnail", () => {
		const html = render({ type: "image", data: "aGVsbG8=", mimeType: "image/png" });
		expect(html).toContain("img-thumb");
		expect(html).toContain("<img");
		expect(html).toContain("data:image/png;base64,aGVsbG8=");
		expect(html).not.toContain("[image]");
	});
});
