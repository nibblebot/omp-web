/**
 * Hiding an extension's status bar (a status or a line widget): the hidden one is not drawn in
 * the composer slot, other contributions are, and the choice is stored in this browser.
 * Rendered through solid's SSR runtime.
 */
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { ExtensionUi } from "../../components/requests/ExtensionUi";
import { setFeaturePreference } from "../../features/preferences";
import { Markdown } from "../../components/ui/Markdown";
import { setState } from "../../state";
import {
	createBrowserUiState,
	hiddenStatusBars,
	setStatusBarHidden,
	type BrowserUiRequest,
} from "../../store/browser-ui";
import {
	installJsxShim,
	installLocalStorageShim,
	restoreBrowserGlobals,
	restoreJsxShim,
} from "../web.testkit";

function request(requestId: string, id: string, kind: "panel" | "widget", text: string) {
	return {
		requestId,
		contribution: {
			id,
			kind,
			owner: "terminal-hooks",
			title: "",
			payload: { blocks: [{ type: "text" as const, text }] },
			version: 1,
		},
		scope: undefined,
		busy: false,
		error: null,
	} satisfies BrowserUiRequest;
}

const render = () =>
	renderToString(() => createComponent(ExtensionUi, { placement: "belowEditor" }));

const unhideAll = () => {
	for (const bar of hiddenStatusBars()) setStatusBarHidden(bar.id, false);
};

beforeEach(() => {
	installLocalStorageShim();
	restoreJsxShim();
	// The shim builds both branches of a Show; these plain-text blocks never show Markdown.
	installJsxShim({ onElement: (type) => (type === Markdown ? { value: "" } : undefined) });
	setState("browserUi", {
		requests: [
			request("ui1", "status:git", "panel", "main +2"),
			request("ui2", "status:tokens", "panel", "12k tokens"),
			// Same key as a status: a different bar, hidden on its own.
			request("ui3", "widget:git", "widget", "3 files changed"),
		],
		error: null,
	});
});

afterEach(() => {
	unhideAll();
	restoreBrowserGlobals();
});

afterAll(() => {
	restoreJsxShim();
	setState("browserUi", createBrowserUiState());
});

test("a hidden status is not drawn; other statuses and a widget with the same key are", () => {
	expect(render()).toContain("main +2");
	setStatusBarHidden("status:git", true);
	const html = render();
	expect(html).not.toContain("main +2");
	expect(html).toContain("12k tokens");
	expect(html).toContain("3 files changed");
});

test("a hidden line widget is not drawn", () => {
	setStatusBarHidden("widget:git", true);
	const html = render();
	expect(html).not.toContain("3 files changed");
	expect(html).toContain("main +2");
});

test("showing a hidden bar again draws it and clears the stored choice", () => {
	setStatusBarHidden("status:git", true, "omp-git");
	setStatusBarHidden("widget:git", true);
	expect(JSON.parse(localStorage.getItem("omp.hiddenStatusBars") ?? "null")).toEqual([
		{ id: "status:git", plugin: "omp-git" },
		{ id: "widget:git" },
	]);
	setStatusBarHidden("status:git", false);
	expect(render()).toContain("main +2");
	expect(JSON.parse(localStorage.getItem("omp.hiddenStatusBars") ?? "null")).toEqual([
		{ id: "widget:git" },
	]);
	setStatusBarHidden("widget:git", false);
	expect(localStorage.getItem("omp.hiddenStatusBars")).toBeNull();
});

test("with the Plugins feature off a hidden status is drawn", () => {
	setStatusBarHidden("status:git", true);
	setFeaturePreference("plugins", false);
	try {
		expect(render()).toContain("main +2");
	} finally {
		setFeaturePreference("plugins", true);
	}
});
