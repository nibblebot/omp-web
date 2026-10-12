import { describe, expect, test } from "bun:test";
import { FEATURE_BY_ID, featureForModal } from "../../features/manifest";

describe("debug feature manifest", () => {
	test("owns the debug modal and no slash commands", () => {
		expect(FEATURE_BY_ID.debug.modals).toEqual(["debug"]);
		expect(FEATURE_BY_ID.debug.commands).toEqual([]);
		expect(featureForModal("debug")?.id).toBe("debug");
	});
});
