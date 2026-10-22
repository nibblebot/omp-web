import { describe, expect, test } from "bun:test";
import { openModelSettings } from "../../store/models";
import { setState, state } from "../../state";

describe("Settings > Features: advisor link", () => {
	test("its link opens Settings on the Model tab", () => {
		setState({ settingsTab: null, modal: null });
		openModelSettings();
		expect(state.settingsTab).toBe("model");
		expect(state.modal).toBe("settings");
	});
});
