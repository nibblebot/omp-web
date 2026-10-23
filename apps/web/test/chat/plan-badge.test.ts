/**
 * The session bar's plan badge. Plan mode can be on (set from the terminal) while the
 * Plan Mode feature is off: the badge then only reports it. While the feature is active
 * the badge is the exit control. Rendered through solid's SSR runtime; the JSX shim
 * records the badge's props so its click handler can be invoked without a DOM.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { StatusSegment } from "../../components/chat/status/StatusSegment";
import { SessionConfigBar } from "../../components/chat/status/SessionConfigBar";
import { FEATURE_IDS, type FeatureId } from "../../features/manifest";
import { activateFeatures, isFeatureEnabled } from "../../features/registry";
import { connect, setState, state } from "../../state";
import {
	FakeWebSocket,
	installJsxShim,
	installTransportStubs,
	posted,
	restoreBrowserGlobals,
	restoreJsxShim,
} from "../web.testkit";

let baselineFeatures: FeatureId[] = [];
let baselinePlanMode = false;
// The classic JSX transform builds `fallback` eagerly, so a created element is not necessarily
// a rendered one: every plan badge element is recorded and the HTML decides which rendered.
let badgeProps: Record<string, unknown>[] = [];

beforeAll(() => {
	baselineFeatures = FEATURE_IDS.filter(isFeatureEnabled);
	baselinePlanMode = state.planModeEnabled;
});

afterAll(async () => {
	restoreJsxShim();
	await activateFeatures(baselineFeatures);
	setState("planModeEnabled", baselinePlanMode);
});

beforeEach(() => {
	installTransportStubs();
	restoreJsxShim();
	badgeProps = [];
	installJsxShim({
		onElement(type, props) {
			if (type === StatusSegment && String(props.class).includes("plan-badge"))
				badgeProps.push(props);
			return undefined;
		},
	});
});

afterEach(restoreBrowserGlobals);

const render = () => renderToString(() => createComponent(SessionConfigBar, {}));

describe("plan badge", () => {
	test("is absent while plan mode is off", async () => {
		await activateFeatures([]);
		setState("planModeEnabled", false);
		expect(render()).not.toContain("plan-badge");
	});

	test("with the plan feature off it reports plan mode as a read-only span that does nothing", async () => {
		await activateFeatures([]);
		setState("planModeEnabled", true);
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		posted.length = 0;
		const html = render();
		expect(html).toMatch(/<span[^>]*plan-badge[^>]*>Plan mode<\/span>/);
		expect(html).not.toMatch(/<button[^>]*plan-badge/);
		expect(badgeProps.some((props) => props.onClick !== undefined)).toBe(false);
		expect(posted.some((c) => c.type === "call")).toBe(false);
		expect(state.planModeEnabled).toBe(true);
	});

	test("with the plan feature active it is a button that turns plan mode off", async () => {
		await activateFeatures(["plan"]);
		setState("planModeEnabled", true);
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		posted.length = 0;
		const html = render();
		expect(html).toMatch(/<button[^>]*plan-badge/);
		(badgeProps.find((props) => !props.readOnly)!.onClick as () => void)();
		expect(posted).toContainEqual(
			expect.objectContaining({
				type: "call",
				method: "setPlanModeState",
				args: [{ enabled: false }],
			}),
		);
	});
});
