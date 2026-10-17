import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as transport from "../../store/transport";
import { setState, state } from "../../state";
import {
	cycleModelPreset,
	openModelPicker,
	setThinkingSelector,
	switchSessionModel,
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
});

afterEach(() => restore());

function notices(): Array<{ level: string; message: string }> {
	return state.items.flatMap((item) =>
		item.kind === "notice" ? [{ level: item.level, message: item.message }] : [],
	);
}

describe("cycleModelPreset", () => {
	test("applies the preset after the active one and wraps around", async () => {
		respond = (_m, args) => ({ applied: args[0], warnings: [] });
		setState("modelPresets", { names: ["fast", "deep", "cheap"], active: "deep" });
		await cycleModelPreset();
		expect(calls).toEqual([{ method: "applyModelPreset", args: ["cheap"] }]);

		setState("modelPresets", { names: ["fast", "deep", "cheap"], active: "cheap" });
		await cycleModelPreset();
		expect(calls[1]).toEqual({ method: "applyModelPreset", args: ["fast"] });
	});

	test("backward steps to the previous preset and wraps to the last", async () => {
		respond = (_m, args) => ({ applied: args[0], warnings: [] });
		setState("modelPresets", { names: ["fast", "deep", "cheap"], active: "fast" });
		await cycleModelPreset(true);
		expect(calls[0]).toEqual({ method: "applyModelPreset", args: ["cheap"] });
	});

	test("starts at the first preset when none is active", async () => {
		respond = (_m, args) => ({ applied: args[0], warnings: [] });
		setState("modelPresets", { names: ["fast", "deep"] });
		await cycleModelPreset();
		expect(calls[0]).toEqual({ method: "applyModelPreset", args: ["fast"] });
	});

	test("states when no presets are configured and sends nothing", async () => {
		expect(await cycleModelPreset()).toBe(false);
		expect(calls).toEqual([]);
		expect(notices()).toEqual([{ level: "info", message: "No model presets configured." }]);
	});
});

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

describe("openModelPicker", () => {
	test("opens the model modal in session or Task mode and loads the browser", async () => {
		respond = () => [];
		openModelPicker();
		expect(state.modal).toBe("model");
		expect(state.modelPickerTask).toBe(false);
		openModelPicker(true);
		expect(state.modelPickerTask).toBe(true);
		await Promise.resolve();
		expect(calls.map((c) => c.method)).toEqual(["getModelBrowser", "getModelBrowser"]);
	});
});
