import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Suspense, createComponent } from "solid-js";
import { renderToStringAsync } from "solid-js/web";
import type { ModelBrowserEntry, ModelRoleCatalogEntry } from "#lib/wire/protocol";
import { ModelRoleTable } from "../../components/settings/ModelRoleTable";
import { connect, setState } from "../../state";
import {
	FakeEventSource,
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
	FakeEventSource.instances.at(-1)!.onopen?.();
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

describe("Settings > Model role selects", () => {
	test("the role table loads the model browser the quick picker reads", async () => {
		await renderTable();
		expect(posted.filter((c) => c.type === "call" && c.method === "getModelBrowser")).toHaveLength(
			1,
		);
	});

	test("every role select lists the models; locked ones are disabled with their reason", async () => {
		const html = await renderTable();
		const advisor = html.slice(html.indexOf('aria-label="Model for role Advisor"'));
		expect(advisor).toMatch(/<option[^>]*value="opencode-go\/deepseek-v4\.1-flash"/);
		expect(advisor).toMatch(/<option[^>]*value="moonshot\/kimi-k3"[^>]*disabled[^>]*>/);
		expect(advisor).toMatch(/<option[^>]*value="openai\/gpt-x"[^>]*disabled[^>]*>/);
		expect(html.match(/No credentials for moonshot\. Run \/login\./g)).toHaveLength(2);
		expect(html.match(/is disabled\./g)).toHaveLength(2);
	});
});
