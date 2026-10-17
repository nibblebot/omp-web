import { describe, expect, test } from "bun:test";
import { searchFeatures } from "../../components/settings/FeaturesSettings";
import { openModelSettings } from "../../store/models";
import { setState, state } from "../../state";

describe("Settings > Features: advisor row", () => {
	test("is named for the browser and says where the advisor is turned on", () => {
		const row = searchFeatures("advisor in the browser").find((f) => f.id === "advisor");
		expect(row?.label).toBe("Advisor in the browser");
		expect(row?.description).toContain("Settings > Model > Advisor");
	});

	test("its link opens Settings on the Model tab", () => {
		setState({ settingsTab: null, modal: null });
		openModelSettings();
		expect(state.settingsTab).toBe("model");
		expect(state.modal).toBe("settings");
	});
});
