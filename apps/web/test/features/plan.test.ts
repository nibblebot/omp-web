import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { FEATURE_IDS, type FeatureId } from "../../features/manifest";
import { activateFeatures, featureCommand, isFeatureEnabled } from "../../features/registry";
import { planDispatch } from "../../features/plan";
import { dispatchInput } from "../../prompt/commands";
import { connect, setState, state } from "../../state";
import {
	callResult,
	dispatch,
	FakeWebSocket,
	installTransportStubs,
	posted,
	restoreBrowserGlobals,
} from "../web.testkit";

// The plan feature is in development, so only activateFeatures can load it. The baseline
// active set goes back in afterAll so later files in the same process see the real defaults.
let baselineFeatures: FeatureId[] = [];
let baselinePlanMode = false;

beforeAll(() => {
	baselineFeatures = FEATURE_IDS.filter(isFeatureEnabled);
	baselinePlanMode = state.planModeEnabled;
});

afterAll(async () => {
	await activateFeatures(baselineFeatures);
	setState("planModeEnabled", baselinePlanMode);
});

beforeEach(async () => {
	installTransportStubs();
	setState({ items: [], streaming: false, planModeEnabled: false, modal: null });
	await activateFeatures(["plan"]);
});

afterEach(restoreBrowserGlobals);

function planCalls() {
	return posted.filter((c) => c.type === "call" && c.method === "setPlanModeState");
}

describe("planDispatch", () => {
	test("a bare /plan toggles plan mode against the current state", () => {
		setState("planModeEnabled", false);
		expect(planDispatch().args[0]).toEqual({ enabled: true });
		setState("planModeEnabled", true);
		expect(planDispatch().args[0]).toEqual({ enabled: false });
	});

	test("a prompt always enters plan mode, even when it is already on", () => {
		setState("planModeEnabled", false);
		expect(planDispatch("design the api").args[0].enabled).toBe(true);
		setState("planModeEnabled", true);
		expect(planDispatch("design the api").args[0].enabled).toBe(true);
		expect(planDispatch("   ").args[0].enabled).toBe(false);
	});
});

describe("/plan with the plan feature active", () => {
	test("a bare /plan sends setPlanModeState with the toggled value", () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		posted.length = 0;
		dispatchInput("/plan", undefined, "enter");
		expect(planCalls()).toMatchObject([{ args: [{ enabled: true }] }]);
	});

	test("/plan with a prompt enters plan mode and sends the prompt after it", async () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		posted.length = 0;
		featureCommand("plan")!.command.run("design the api");
		const [toggle] = planCalls();
		expect(toggle).toMatchObject({ args: [{ enabled: true }] });
		// The prompt waits for the mode switch to be acknowledged.
		expect(posted.some((c) => c.type === "call" && c.method === "prompt")).toBe(false);
		dispatch(callResult((toggle as { id: string }).id, undefined));
		await Bun.sleep(0);
		expect(posted).toContainEqual(
			expect.objectContaining({ type: "call", method: "prompt", args: ["design the api"] }),
		);
	});
});

describe("/plan-review", () => {
	test("bare /plan-review opens the sheet; arguments are refused and open nothing", () => {
		featureCommand("plan-review")!.command.run("x");
		expect(state.modal).toBeNull();
		featureCommand("plan-review")!.command.run("");
		expect(state.modal).toBe("plan-review");
	});
});
