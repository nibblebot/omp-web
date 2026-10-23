import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { FEATURE_IDS, type FeatureId } from "../../features/manifest";
import { activateFeatures, featureCommand, isFeatureEnabled } from "../../features/registry";
import { connect, setState, state } from "../../state";
import {
	FakeWebSocket,
	installTransportStubs,
	posted,
	restoreBrowserGlobals,
} from "../web.testkit";

// The todos feature is in development, so only activateFeatures can load it. The baseline
// active set goes back in afterAll so later files in the same process see the real defaults
// (prompt/commands.test.ts asserts the in-development notice).
let baselineFeatures: FeatureId[] = [];

beforeAll(() => {
	baselineFeatures = FEATURE_IDS.filter(isFeatureEnabled);
});

afterAll(async () => {
	await activateFeatures(baselineFeatures);
});

beforeEach(async () => {
	installTransportStubs();
	setState({ modal: null });
	await activateFeatures(["todos"]);
});

afterEach(restoreBrowserGlobals);

describe("todos feature", () => {
	test("bare /todo opens the todos sheet without calling the agent", () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		posted.length = 0;
		featureCommand("todo")!.command.run("");
		expect(state.modal).toBe("todos");
		expect(posted.some((c) => c.type === "call")).toBe(false);
	});

	test("/todo with arguments forwards the whole command to the agent and leaves the sheet closed", () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		posted.length = 0;
		featureCommand("todo")!.command.run("add write tests");
		expect(state.modal).toBeNull();
		expect(posted).toContainEqual(
			expect.objectContaining({ type: "call", method: "prompt", args: ["/todo add write tests"] }),
		);
	});
});
