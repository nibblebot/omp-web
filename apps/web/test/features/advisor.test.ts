import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { ServerFrame } from "#lib/wire/protocol";
import { FEATURE_IDS, type FeatureId } from "../../features/manifest";
import { activateFeatures, isFeatureEnabled } from "../../features/registry";
import { connect, setState, state } from "../../state";
import {
	FakeEventSource,
	assistantMsg,
	attached,
	dispatch,
	installTransportStubs,
	itemCounts,
	restoreBrowserGlobals,
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
