import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as transport from "../../store/transport";
import { setState, state } from "../../state";
import {
	deleteModelPreset,
	openModelDialog,
	presetNameError,
	saveModelPreset,
	selectModelDialogRole,
	selectModelDialogTab,
	setModelPickerTask,
	setThinkingSelector,
	switchSessionModel,
	updateModelPreset,
} from "../../store/models";

// Server round trips are replaced by a spy on the transport's `call`, so each
// test asserts the wire method and args the store sends and the notice it
// surfaces. Notices are the user-visible outcome (CORE-10).
type Call = { method: string; args: unknown[] };
let calls: Call[] = [];
let respond: (method: string, args: unknown[]) => unknown = () => undefined;
let restore: () => void = () => {};

beforeEach(() => {
	calls = [];
	respond = () => undefined;
	const spy = spyOn(transport, "call").mockImplementation(async (method, args = []) => {
		calls.push({ method, args });
		return respond(method, args);
	});
	restore = () => spy.mockRestore();
	setState("items", []);
	setState("modal", null);
	setState("modelPresets", undefined);
	setState("modelPresetDetails", undefined);
	setState("modelDialogTab", "presets");
	setState("modelDialogRole", undefined);
	setState("modelPickerTask", false);
});

afterEach(() => restore());

function notices(): Array<{ level: string; message: string }> {
	return state.items.flatMap((item) =>
		item.kind === "notice" ? [{ level: item.level, message: item.message }] : [],
	);
}

/** Let fire-and-forget loads started by `openModelDialog` finish (microtasks only). */
async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("switchSessionModel", () => {
	test("reports the session-only switch as a notice", async () => {
		respond = () => ({ provider: "opencode-go", id: "deepseek-v4.1-flash", thinkingLevel: "low" });
		expect(await switchSessionModel("deepseek")).toBe(true);
		expect(calls).toEqual([{ method: "switchModel", args: ["deepseek"] }]);
		expect(notices()).toEqual([
			{
				level: "info",
				message:
					"Session-only model: opencode-go/deepseek-v4.1-flash (thinking low). Roles unchanged.",
			},
		]);
	});

	test("surfaces the server's real error text, never 'undefined'", async () => {
		respond = () => {
			throw new Error('Model "zzz" not found. Use --list-models to see available models.');
		};
		expect(await switchSessionModel("zzz")).toBe(false);
		const [notice] = notices();
		expect(notice.level).toBe("error");
		expect(notice.message).toContain('Model "zzz" not found');
		expect(notice.message).not.toContain("undefined");
	});
});

describe("setThinkingSelector", () => {
	test("does not claim success when the server rejects an unsupported level", async () => {
		respond = () => {
			throw new Error('Thinking "xhigh" is not supported by a/b. Supported: off, low.');
		};
		expect(await setThinkingSelector("xhigh")).toBe(false);
		expect(notices()[0]?.level).toBe("error");
		expect(notices()[0]?.message).toContain("Supported: off, low.");
	});

	test("notices the new level on success", async () => {
		expect(await setThinkingSelector("low")).toBe(true);
		expect(calls).toEqual([{ method: "setThinkingLevel", args: ["low"] }]);
		expect(notices()).toEqual([{ level: "info", message: "Thinking: low." }]);
	});
});

describe("openModelDialog", () => {
	const loads = (method: string) =>
		method === "getModelPresets" ? { names: [], presets: [] } : [];

	test("opens the Roles tab on the default role and loads browser and presets", async () => {
		respond = loads;
		openModelDialog("roles");
		expect(state.modal).toBe("model");
		expect(state.modelDialogTab).toBe("roles");
		expect(state.modelDialogRole).toBe("default");
		expect(state.modelPickerTask).toBe(false);
		await settle();
		expect(calls.map((c) => c.method).sort()).toEqual(["getModelBrowser", "getModelPresets"]);
		expect(state.modelPresetDetails).toEqual([]);
	});

	test("selects the named role and resets the Task toggle", async () => {
		respond = loads;
		setState("modelPickerTask", true);
		openModelDialog("roles", "advisor");
		expect(state.modelDialogRole).toBe("advisor");
		expect(state.modelPickerTask).toBe(false);
		await settle();
	});

	test("opens the Presets tab without a role selection", async () => {
		respond = loads;
		setState("modelDialogRole", "slow");
		openModelDialog("presets");
		expect(state.modelDialogTab).toBe("presets");
		expect(state.modelDialogRole).toBeUndefined();
		await settle();
	});

	test("tab, role and Task toggle setters write their state fields", () => {
		selectModelDialogTab("all");
		selectModelDialogRole("plan");
		setModelPickerTask(true);
		expect(state.modelDialogTab).toBe("all");
		expect(state.modelDialogRole).toBe("plan");
		expect(state.modelPickerTask).toBe(true);
	});
});

describe("presetNameError", () => {
	test("rejects an empty name", () => {
		expect(presetNameError("", [])).toBe("Enter a name");
	});

	test("rejects a leading digit, a space and other punctuation", () => {
		const message = "Use a letter, then letters, digits, - or _";
		expect(presetNameError("1fast", [])).toBe(message);
		expect(presetNameError("my preset", [])).toBe(message);
		expect(presetNameError("-fast", [])).toBe(message);
		expect(presetNameError("_fast", [])).toBe(message);
		expect(presetNameError("fast.v2", [])).toBe(message);
	});

	test("accepts letters, digits, - and _ after the first letter", () => {
		expect(presetNameError("f", [])).toBeUndefined();
		expect(presetNameError("fast-2_x", [])).toBeUndefined();
		expect(presetNameError("Deep9", ["fast"])).toBeUndefined();
	});

	test("rejects an exact duplicate but not a case variant", () => {
		expect(presetNameError("fast", ["fast", "deep"])).toBe('A preset named "fast" already exists');
		expect(presetNameError("Fast", ["fast"])).toBeUndefined();
	});
});

describe("preset save, update and delete", () => {
	const details = {
		names: ["fast"],
		presets: [{ name: "fast", source: "global" as const, modelRoles: {} }],
	};

	test("save relays the server message and reloads the details", async () => {
		respond = (method) =>
			method === "saveModelPreset" ? { message: 'Saved preset "fast".' } : details;
		expect(await saveModelPreset("fast")).toBeUndefined();
		expect(calls).toEqual([
			{ method: "saveModelPreset", args: ["fast"] },
			{ method: "getModelPresets", args: [] },
		]);
		expect(notices()).toEqual([{ level: "info", message: 'Saved preset "fast".' }]);
		expect(state.modelPresetDetails).toEqual(details.presets);
	});

	test("save surfaces the server error and does not reload", async () => {
		respond = () => {
			throw new Error("disk full");
		};
		expect(await saveModelPreset("fast")).toBe("disk full");
		expect(calls.map((c) => c.method)).toEqual(["saveModelPreset"]);
		expect(notices()).toEqual([{ level: "error", message: "Preset save failed: disk full" }]);
	});

	test("update re-saves under the same name and notices the update", async () => {
		respond = (method) => (method === "saveModelPreset" ? { message: "ignored" } : details);
		expect(await updateModelPreset("fast")).toBe(true);
		expect(calls).toEqual([
			{ method: "saveModelPreset", args: ["fast"] },
			{ method: "getModelPresets", args: [] },
		]);
		expect(notices()).toEqual([
			{ level: "info", message: 'Updated preset "fast" from current roles.' },
		]);
	});

	test("delete reports success only for a deleted preset", async () => {
		respond = (method) => (method === "deleteModelPreset" ? { result: "deleted" } : details);
		expect(await deleteModelPreset("fast")).toBe(true);
		expect(calls.map((c) => c.method)).toEqual(["deleteModelPreset", "getModelPresets"]);
		expect(notices()).toEqual([{ level: "info", message: 'Deleted preset "fast".' }]);
	});

	test("delete of a project preset or a missing preset warns and returns false", async () => {
		respond = (method) => (method === "deleteModelPreset" ? { result: "project" } : details);
		expect(await deleteModelPreset("fast")).toBe(false);
		respond = (method) => (method === "deleteModelPreset" ? { result: "missing" } : details);
		expect(await deleteModelPreset("gone")).toBe(false);
		expect(notices()).toEqual([
			{
				level: "warning",
				message: 'Preset "fast" lives in a project/overlay config; remove it there.',
			},
			{ level: "warning", message: 'No preset named "gone".' },
		]);
		expect(calls.filter((c) => c.method === "getModelPresets")).toHaveLength(2);
	});

	test("a failed preset list load becomes an error notice", async () => {
		respond = (method) => {
			if (method === "getModelPresets") throw new Error("offline");
			return { result: "deleted" };
		};
		await deleteModelPreset("fast");
		expect(notices().map((n) => n.level)).toEqual(["info", "error"]);
		expect(notices()[1]?.message).toBe("Could not load presets: offline");
	});
});
