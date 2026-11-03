/**
 * The Minimized fact on a bash card: the filter and the bytes before and after, worded as the TUI
 * words them, one plain line however odd the filter label. Rendered through solid's SSR runtime,
 * so the HTML is what the card would put in the DOM.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { formatMinimizedBytes, minimizedSummary } from "../../chat/bash-minimized";
import { BashToolCard } from "../../components/chat/tools/BashToolCard";
import { setState, state, type ToolItem } from "../../state";
import { installJsxShim, restoreJsxShim } from "../web.testkit";

const original = { toolsExpanded: state.toolsExpanded, toolCards: state.display.toolCards };

beforeEach(() => {
	installJsxShim();
	setState("toolsExpanded", false);
	setState("display", "toolCards", "expanded");
});

afterAll(() => {
	restoreJsxShim();
	setState("toolsExpanded", original.toolsExpanded);
	setState("display", "toolCards", original.toolCards);
});

const meta = (minimized: unknown) => ({ meta: { minimized } });
const minimized = (over: Record<string, unknown> = {}) => ({
	filter: "git",
	inputBytes: 123_300,
	outputBytes: 3_277,
	artifactId: "7",
	...over,
});

const bash = (details: unknown): ToolItem => ({
	kind: "tool",
	id: 1,
	toolCallId: "call_1",
	name: "bash",
	args: { command: "git log" },
	status: "done",
	output: "ZZ-OUTPUT-NEEDLE",
	details,
});
const render = (item: ToolItem) => renderToString(() => createComponent(BashToolCard, { item }));

describe("minimizedSummary", () => {
	test("details without minimizer meta give nothing", () => {
		expect(minimizedSummary(undefined)).toBeUndefined();
		expect(minimizedSummary(null)).toBeUndefined();
		expect(minimizedSummary({})).toBeUndefined();
		expect(minimizedSummary({ meta: {} })).toBeUndefined();
		expect(minimizedSummary({ meta: { truncation: {} } })).toBeUndefined();
		expect(minimizedSummary({ meta: null })).toBeUndefined();
	});

	test("the filter and both sizes read as the TUI words them", () => {
		expect(minimizedSummary(meta(minimized()))).toBe("git 120.4KB → 3.2KB");
		expect(minimizedSummary(meta(minimized({ inputBytes: 900, outputBytes: 0 })))).toBe(
			"git 900B → 0B",
		);
		expect(
			minimizedSummary(meta(minimized({ inputBytes: 5 * 1024 ** 2, outputBytes: 3 * 1024 ** 3 }))),
		).toBe("git 5.0MB → 3.0GB");
	});

	test("a malformed meta shows nothing instead of a broken line", () => {
		expect(minimizedSummary(meta("git"))).toBeUndefined();
		expect(minimizedSummary(meta(minimized({ filter: 3 })))).toBeUndefined();
		expect(minimizedSummary(meta(minimized({ inputBytes: "9" })))).toBeUndefined();
		expect(minimizedSummary(meta(minimized({ outputBytes: Number.NaN })))).toBeUndefined();
		expect(minimizedSummary(meta(minimized({ outputBytes: -1 })))).toBeUndefined();
	});

	test("a multi-line, escaped or control-laden label stays one plain line", () => {
		expect(minimizedSummary(meta(minimized({ filter: "git\n  log\t--stat\r\n" })))).toBe(
			"git log --stat 120.4KB → 3.2KB",
		);
		expect(minimizedSummary(meta(minimized({ filter: "\u001b[31mgit\u001b[0m\u0007" })))).toBe(
			"git 120.4KB → 3.2KB",
		);
	});

	test("a long label ends in an ellipsis at 40 characters, sizes intact", () => {
		const summary = minimizedSummary(meta(minimized({ filter: "x".repeat(500) })));
		expect(summary).toBe(`${"x".repeat(39)}… 120.4KB → 3.2KB`);
		expect(summary).not.toContain("\n");
		// Characters, not UTF-16 units: an emoji is never cut in half.
		const emoji = minimizedSummary(meta(minimized({ filter: "😀".repeat(60) })));
		expect(emoji).toBe(`${"😀".repeat(39)}… 120.4KB → 3.2KB`);
	});

	test("an empty label leaves just the sizes", () => {
		expect(minimizedSummary(meta(minimized({ filter: " \n " })))).toBe("120.4KB → 3.2KB");
	});
});

describe("formatMinimizedBytes", () => {
	test("units switch at 1024", () => {
		expect(formatMinimizedBytes(1023)).toBe("1023B");
		expect(formatMinimizedBytes(1024)).toBe("1.0KB");
		expect(formatMinimizedBytes(1024 ** 2)).toBe("1.0MB");
		expect(formatMinimizedBytes(1024 ** 3)).toBe("1.0GB");
	});
});

describe("BashToolCard", () => {
	test("a minimized result shows its Minimized fact under the output", () => {
		const html = render(bash(meta(minimized())));
		expect(html).toContain("ZZ-OUTPUT-NEEDLE");
		expect(html).toContain("Minimized: ");
		expect(html).toContain("git 120.4KB → 3.2KB");
		expect(html.indexOf("ZZ-OUTPUT-NEEDLE")).toBeLessThan(html.indexOf("Minimized: "));
	});

	test("a card without minimizer meta shows no Minimized fact", () => {
		expect(render(bash(undefined))).not.toContain("Minimized");
		expect(render(bash({ exitCode: 0, meta: { truncation: {} } }))).not.toContain("Minimized");
	});
});
