import { describe, expect, test } from "bun:test";
import { clipboardImageCandidates } from "../../prompt/paste";

const item = (type: string) => ({ type });

describe("clipboardImageCandidates", () => {
	test("a supported encoding wins and unsupported alternates of the capture are dropped", () => {
		const png = item("image/png");
		expect(clipboardImageCandidates([item("image/tiff"), png, item("image/x-qt-image")])).toEqual({
			attach: [png],
			convert: [],
		});
	});

	test("with no supported encoding every candidate is offered for conversion, in clipboard order", () => {
		const tiff = item("image/tiff");
		const alias = item("image/x-png");
		expect(clipboardImageCandidates([tiff, alias])).toEqual({ attach: [], convert: [tiff, alias] });
	});
});
