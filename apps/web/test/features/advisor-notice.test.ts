import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { ServerFrame } from "#lib/wire/protocol";
import { FEATURE_IDS, type FeatureId } from "../../features/manifest";
import { featurePreferences, setFeaturePreference } from "../../features/preferences";
import { activateFeatures, isFeatureEnabled } from "../../features/registry";
import { connect, setState, state } from "../../state";
import {
	FakeWebSocket,
	attached,
	dispatch,
	installTransportStubs,
	restoreBrowserGlobals,
	userMsg,
} from "../web.testkit";

let baselineFeatures: FeatureId[];

beforeAll(async () => {
	baselineFeatures = FEATURE_IDS.filter(isFeatureEnabled);
	await activateFeatures([]);
});

afterAll(async () => {
	await activateFeatures(baselineFeatures);
});

beforeEach(() => {
	installTransportStubs();
	setState("items", []);
	setState("toasts", []);
});

afterEach(restoreBrowserGlobals);

function advisorMsg(count: number) {
	return {
		role: "custom",
		customType: "advisor",
		display: true,
		content: "<advisory>…</advisory>",
		details: {
			notes: Array.from({ length: count }, (_, i) => ({ note: `note ${i}`, severity: "concern" })),
		},
		timestamp: 0,
	};
}

function primed(sessionId: string): void {
	connect();
	FakeWebSocket.instances.at(-1)!.onopen?.();
	dispatch(attached(sessionId));
	dispatch({ type: "history", messages: [] } as ServerFrame);
}

function live(message: unknown): void {
	dispatch({ type: "event", event: { type: "message_start", message } } as ServerFrame);
	dispatch({ type: "event", event: { type: "message_end", message } } as ServerFrame);
}

function notices(): { text: string; action?: { label: string; run: () => void } }[] {
	return state.toasts.filter((t) => t.text.startsWith("The advisor left"));
}

describe("advisor notes while the browser feature is off", () => {
	test("live notes raise one notice per session; its action enables the feature", async () => {
		primed("session-notice-live");
		live(advisorMsg(2));
		live(advisorMsg(1));
		expect(notices().map((t) => t.text)).toEqual([
			"The advisor left 2 notes; show advisor in the browser?",
		]);
		const action = notices()[0]?.action;
		expect(action?.label).toBe("Show advisor in the browser");
		action?.run();
		expect(featurePreferences().advisor).toBe(true);
		// run() starts an activation nothing awaits; reset the choice and settle the active set here,
		// so the feature cannot switch on during a later test. Superseding activation drops the stale one.
		setFeaturePreference("advisor", false);
		await activateFeatures([]);
	});

	test("a second session gets its own notice", () => {
		primed("session-notice-first");
		live(advisorMsg(1));
		primed("session-notice-second");
		live(advisorMsg(1));
		expect(notices().map((t) => t.text)).toEqual([
			"The advisor left 1 note; show advisor in the browser?",
			"The advisor left 1 note; show advisor in the browser?",
		]);
	});

	test("replayed history counts every advisor note once, in one notice", () => {
		primed("session-notice-history");
		dispatch({
			type: "history",
			messages: [userMsg("q"), advisorMsg(2), advisorMsg(1)],
		} as ServerFrame);
		expect(notices().map((t) => t.text)).toEqual([
			"The advisor left 3 notes; show advisor in the browser?",
		]);
	});

	test("no notice when the browser feature is on", async () => {
		await activateFeatures(["advisor"]);
		primed("session-notice-on");
		live(advisorMsg(2));
		expect(notices()).toEqual([]);
		await activateFeatures([]);
	});
});
