import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToStringAsync } from "solid-js/web";
import type { ServerFrame } from "#lib/wire/protocol";
import { AdvisorPanel } from "../../components/subagents/AdvisorPanel";
import { FEATURE_IDS, type FeatureId } from "../../features/manifest";
import { activateFeatures, featureModal, isFeatureEnabled } from "../../features/registry";
import { connect, setState, state } from "../../state";
import {
	FakeEventSource,
	assistantMsg,
	attached,
	dispatch,
	flushMicrotasks,
	installJsxShim,
	installTransportStubs,
	itemCounts,
	posted,
	restoreBrowserGlobals,
	restoreJsxShim,
	userMsg,
} from "../web.testkit";

let baselineFeatures: FeatureId[];

beforeAll(async () => {
	baselineFeatures = FEATURE_IDS.filter(isFeatureEnabled);
	await activateFeatures(["advisor"]);
});

afterAll(async () => {
	await activateFeatures(baselineFeatures);
});

beforeEach(() => {
	installTransportStubs();
	setState("items", []);
});

afterEach(restoreBrowserGlobals);

describe("advisor notes render inline (TUI advisor card parity)", () => {
	const notes = [
		{ note: "check the null path", severity: "concern" },
		{ note: "ship it", advisor: "reviewer", turnsAgo: 2 },
	];
	const advisorMsg = {
		role: "custom",
		customType: "advisor",
		display: true,
		content: "<advisory>…</advisory>",
		details: { notes },
		timestamp: 0,
	};

	function primed(): void {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		dispatch(attached("session-a"));
	}

	test("history: advisor messages become advisor items; other custom messages stay hidden", () => {
		primed();
		dispatch({
			type: "history",
			messages: [
				userMsg("q"),
				advisorMsg,
				{
					role: "custom",
					customType: "loop-continuation",
					display: false,
					content: "x",
					timestamp: 0,
				},
				assistantMsg("a"),
			],
		} as ServerFrame);
		expect(state.items.map((it) => it.kind)).toEqual(["user", "advisor", "assistant"]);
		expect(state.items[1]).toMatchObject({ kind: "advisor", notes });
	});

	test("live: a steered/preserved advisor card (message_start + message_end) lands exactly once", () => {
		primed();
		dispatch({ type: "history", messages: [] });
		const ev = (event: unknown): ServerFrame => ({ type: "event", event }) as ServerFrame;
		dispatch(ev({ type: "message_start", message: advisorMsg }));
		dispatch(ev({ type: "message_end", message: advisorMsg }));
		expect(itemCounts()).toEqual({ advisor: 1 });
		expect(state.items[0]).toMatchObject({ kind: "advisor", notes });
	});
});

describe("advisor sheet modal", () => {
	test("the Open advisor button's modal resolves to the advisor sheet", () => {
		expect(featureModal("advisor")).toBeDefined();
	});
});

describe("advisor sheet panel wire requests", () => {
	test("stats and warnings read advisorGetStatus by section, never as probe or stats flags", async () => {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		dispatch(attached("session-a"));
		installJsxShim();
		void renderToStringAsync(() => createComponent(AdvisorPanel, {}));
		try {
			await flushMicrotasks();
			const calls = posted.flatMap((c) => (c.type === "call" ? [c] : []));
			expect(calls).toContainEqual(
				expect.objectContaining({ method: "advisorGetStatus", args: [{ section: "stats" }] }),
			);
			expect(calls).toContainEqual(
				expect.objectContaining({ method: "advisorGetStatus", args: [{ section: "warnings" }] }),
			);
			expect(calls.some((c) => c.method === "advisorConfigure")).toBe(false);
		} finally {
			restoreJsxShim();
		}
	});
});
