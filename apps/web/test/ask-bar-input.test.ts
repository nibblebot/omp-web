/**
 * The `input` dialog (AskText) is a text field; with the SDK's `secret` option the typed
 * characters are masked (a password-type field). Rendered through solid's SSR runtime.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { AskText } from "../components/requests/AskBar";
import { installJsxShim, restoreJsxShim } from "./web.testkit";

beforeEach(() => installJsxShim({ onElement: () => undefined }));
afterAll(restoreJsxShim);

function render(props: { multiline: boolean; title: string; secret?: boolean }): string {
	return renderToString(() => createComponent(AskText, { id: "ui1", ...props }));
}

describe("input dialog", () => {
	test("a secret input is a masked password field", () => {
		const html = render({ multiline: false, title: "API token", secret: true });
		expect(html).toContain('type="password"');
		expect(html).not.toContain('type="text"');
	});

	test("a plain input stays a visible text field", () => {
		const html = render({ multiline: false, title: "Branch" });
		expect(html).toContain('type="text"');
		expect(html).not.toContain('type="password"');
	});

	test("an editor is a textarea even when flagged secret", () => {
		const html = render({ multiline: true, title: "Notes", secret: true });
		expect(html).toContain("<textarea");
		expect(html).not.toContain('type="password"');
	});
});
