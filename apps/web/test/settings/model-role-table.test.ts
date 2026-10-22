import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Suspense, createComponent } from "solid-js";
import { renderToStringAsync } from "solid-js/web";
import type { ModelBrowserEntry, ModelRoleCatalogEntry } from "#lib/wire/protocol";
import { ModelRoleTable } from "../../components/settings/ModelRoleTable";
import { connect, setState } from "../../state";
import {
	FakeWebSocket,
	attached,
	callResult,
	dispatch,
	flushMicrotasks,
	installJsxShim,
	installTransportStubs,
	posted,
	restoreBrowserGlobals,
	restoreJsxShim,
} from "../web.testkit";

const roles: ModelRoleCatalogEntry[] = [
	{
		role: "default",
		name: "Default",
		tag: "DEFAULT",
		hidden: false,
		provider: "opencode-go",
		id: "deepseek-v4.1-flash",
		source: "global",
	},
	{ role: "advisor", name: "Advisor", tag: "ADVISOR", hidden: false, source: "default" },
];

const models: ModelBrowserEntry[] = [
	{ provider: "opencode-go", id: "deepseek-v4.1-flash", contextWindow: 1, reasoning: true },
	{
		provider: "moonshot",
		id: "kimi-k3",
		contextWindow: 1,
		reasoning: true,
		locked: "credentials",
	},
	{ provider: "openai", id: "gpt-x", contextWindow: 1, reasoning: false, locked: "disabled" },
];

beforeEach(() => {
	installTransportStubs();
});

afterEach(restoreBrowserGlobals);

/** Render the role table, answering each getModelBrowser call it posts with `models`. */
async function renderTable(): Promise<string> {
	connect();
	FakeWebSocket.instances.at(-1)!.onopen?.();
	dispatch(attached("session-a"));
	setState("modelBrowser", []);
	setState("modelRoleCatalog", roles);
	installJsxShim();
	try {
		const html = renderToStringAsync(() =>
			createComponent(Suspense, {
				get children() {
					return createComponent(ModelRoleTable, {});
				},
			}),
		);
		await flushMicrotasks();
		for (const c of posted) {
			if (c.type !== "call" || c.method !== "getModelBrowser") continue;
			dispatch(callResult(c.id, models));
		}
		await flushMicrotasks();
		return await html;
	} finally {
		restoreJsxShim();
	}
}

describe("Settings > Model role rows", () => {
	test("the role table loads the model browser the quick picker reads", async () => {
		await renderTable();
		expect(posted.filter((c) => c.type === "call" && c.method === "getModelBrowser")).toHaveLength(
			1,
		);
	});

	test("each role shows its model on a picker button, not a native select of every model", async () => {
		const html = await renderTable();
		expect(html).toContain('aria-label="Model for role Advisor"');
		expect(html).toContain('aria-label="Model for role Default"');
		expect(html).not.toContain('<select aria-label="Model for role');
		expect(html).not.toContain('<option value="moonshot/kimi-k3"');
	});
});
