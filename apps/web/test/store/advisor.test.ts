import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Suspense, createComponent } from "solid-js";
import { renderToStringAsync } from "solid-js/web";
import type { ServerFrame } from "#lib/wire/protocol";
import { AdvisorPanel } from "../../components/subagents/AdvisorPanel";
import { connect, setState, state } from "../../state";
import {
	FakeWebSocket,
	assistantMsg,
	attached,
	callResult,
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
		FakeWebSocket.instances.at(-1)!.onopen?.();
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

describe("advisor sheet panel wire requests", () => {
	test("stats and warnings read advisorGetStatus by section, never as probe or stats flags", async () => {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
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

describe("advisor sheet actions follow real state", () => {
	/** Render the panel, answering each advisorGetStatus read it posts; `overview` is the case under test. */
	async function renderPanel(overview: unknown): Promise<string> {
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
		dispatch(attached("session-a"));
		installJsxShim();
		try {
			const html = renderToStringAsync(() =>
				createComponent(Suspense, {
					get children() {
						return createComponent(AdvisorPanel, {});
					},
				}),
			);
			await flushMicrotasks();
			const answers: Record<string, unknown> = { overview, warnings: [], stats: {} };
			for (const c of posted) {
				if (c.type !== "call" || c.method !== "advisorGetStatus") continue;
				const section = (c.args?.[0] as { section?: string } | undefined)?.section ?? "overview";
				dispatch(callResult(c.id, answers[section]));
			}
			await flushMicrotasks();
			return await html;
		} finally {
			restoreJsxShim();
		}
	}

	test("disabled with an advisor role model: Enable is the only action", async () => {
		const html = await renderPanel({
			configured: false,
			active: false,
			roleResolvable: true,
			advisors: [],
		});
		expect(html).toMatch(/>enable</);
		expect(html).not.toMatch(/>disable</);
		expect(html).not.toMatch(/stop advisories/);
		expect(html).not.toMatch(/Assign in Models dialog/);
	});

	test("disabled without an advisor role model: reason and Models dialog link, no Enable", async () => {
		const html = await renderPanel({
			configured: false,
			active: false,
			roleResolvable: false,
			advisors: [],
		});
		expect(html).not.toMatch(/>enable</);
		expect(html).toMatch(/No model is assigned to the advisor role/);
		expect(html).toMatch(/Assign in Models dialog/);
	});

	test("running: Disable and Stop advisories, no Enable", async () => {
		const html = await renderPanel({
			configured: true,
			active: true,
			roleResolvable: true,
			advisors: [{ name: "reviewer", status: "running", yielded: false }],
		});
		expect(html).not.toMatch(/>enable</);
		expect(html).toMatch(/>disable</);
		expect(html).toMatch(/>stop advisories</);
		expect(html).not.toMatch(/Assign in Models dialog/);
	});

	test("enabled without an advisor role model: reason, link and Disable; no Enable or Stop", async () => {
		const html = await renderPanel({
			configured: true,
			active: false,
			roleResolvable: false,
			advisors: [{ name: "reviewer", status: "no_model", yielded: false }],
		});
		expect(html).not.toMatch(/>enable</);
		expect(html).not.toMatch(/stop advisories/);
		expect(html).toMatch(/>disable</);
		expect(html).toMatch(/No model is assigned to the advisor role/);
		expect(html).toMatch(/Assign in Models dialog/);
	});
});
