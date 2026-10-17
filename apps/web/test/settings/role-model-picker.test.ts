import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { ModelBrowserEntry } from "#lib/wire/protocol";
import { moveCursor } from "../../components/models/ModelSearchList";
import { RoleModelPicker } from "../../components/settings/RoleModelPicker";
import { setState } from "../../state";
import {
	installJsxShim,
	installTransportStubs,
	restoreBrowserGlobals,
	restoreJsxShim,
} from "../web.testkit";

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
	setState("modelBrowser", models);
});

afterEach(() => {
	setState("modelBrowser", []);
	restoreBrowserGlobals();
});

const noop = (): void => undefined;
const noopAsync = async (): Promise<boolean> => true;

function render(open: boolean, selector?: string): string {
	installJsxShim();
	try {
		return renderToString(() =>
			createComponent(RoleModelPicker, {
				role: "advisor",
				name: "Advisor",
				selector,
				open,
				disabled: false,
				onOpen: noop,
				onClose: noop,
				onPick: noopAsync,
				onClear: noopAsync,
			}),
		);
	} finally {
		restoreJsxShim();
	}
}

describe("RoleModelPicker (Settings > Model role row)", () => {
	test("the closed row shows the assigned model on a button, with no native select or list", () => {
		const html = render(false, "opencode-go/deepseek-v4.1-flash");
		expect(html).toContain('aria-label="Model for role Advisor"');
		expect(html).toContain('aria-expanded="false"');
		expect(html).toContain("opencode-go/deepseek-v4.1-flash");
		expect(html).not.toContain("<select");
		expect(html).not.toContain("<input");
		expect(html).not.toContain("Clear (inherit)");
	});

	test("opening the row shows a searchable list; locked models are disabled with their reason", () => {
		const html = render(true);
		expect(html).toContain('aria-expanded="true"');
		expect(html).toContain('aria-label="Search models for role Advisor"');
		const moonshot = html.match(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*moonshot\/kimi-k3/s);
		expect(moonshot).not.toBeNull();
		expect(html).toContain("No credentials for moonshot. Run /login.");
		const openai = html.match(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*openai\/gpt-x/s);
		expect(openai).not.toBeNull();
		expect(html).toContain('Provider "openai" is disabled.');
	});

	test("the open picker keeps Clear (inherit) and marks the assigned model as current", () => {
		const html = render(true, "opencode-go/deepseek-v4.1-flash");
		expect(html).toContain("Clear (inherit)");
		expect(html).toContain("current");
	});
});

describe("moveCursor (keyboard reach through the model list)", () => {
	test("steps forward and back, wrapping at both ends", () => {
		expect(moveCursor(0, 3, 1)).toBe(1);
		expect(moveCursor(2, 3, 1)).toBe(0);
		expect(moveCursor(0, 3, -1)).toBe(2);
	});

	test("clamps a cursor past the end before stepping, and is 0 with no selectable rows", () => {
		expect(moveCursor(9, 3, 1)).toBe(0);
		expect(moveCursor(0, 0, 1)).toBe(0);
	});
});
