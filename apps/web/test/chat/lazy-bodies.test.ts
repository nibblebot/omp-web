/**
 * Bodies nobody opened are not mounted: a closed tool card, a collapsed JSON node and the rows of a big eval table past the first screenful. Rendered through
 * solid's SSR runtime, so what the HTML holds is what the card would put in the DOM.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { EvalTable } from "../../components/chat/tools/EvalTable";
import { ToolCard } from "../../components/chat/tools/ToolCard";
import { JsonTree } from "../../components/ui/JsonTree";
import { setState, state, type ToolItem } from "../../state";
import { installJsxShim, restoreJsxShim } from "../web.testkit";

const original = { toolsExpanded: state.toolsExpanded, toolCards: state.display.toolCards };

beforeEach(() => {
	installJsxShim({ onElement: () => undefined });
	setState("toolsExpanded", false);
	setState("display", "toolCards", original.toolCards);
});

afterAll(() => {
	restoreJsxShim();
	setState("toolsExpanded", original.toolsExpanded);
	setState("display", "toolCards", original.toolCards);
});

const writeCall = (over: Partial<ToolItem> = {}): ToolItem => ({
	kind: "tool",
	id: 1,
	toolCallId: "call_1",
	name: "write",
	args: { path: "notes.txt", content: "ZZ-WRITE-NEEDLE\nsecond line" },
	status: "done",
	output: "",
	...over,
});

const bashCall = (over: Partial<ToolItem> = {}): ToolItem => ({
	kind: "tool",
	id: 2,
	toolCallId: "call_2",
	name: "bash",
	args: { command: "echo hi" },
	status: "done",
	output: "ZZ-BASH-NEEDLE",
	...over,
});

const render = (item: ToolItem) => renderToString(() => createComponent(ToolCard, { item }));

describe("tool card bodies", () => {
	test("a closed collapsible card renders its header only, an open one its body", () => {
		const closed = render(writeCall());
		expect(closed).toContain("notes.txt");
		expect(closed).toContain("+2");
		expect(closed).not.toContain("ZZ-WRITE-NEEDLE");

		setState("toolsExpanded", true);
		expect(render(writeCall())).toContain("ZZ-WRITE-NEEDLE");
		setState("toolsExpanded", false);
		expect(render(writeCall({ status: "running" }))).toContain("ZZ-WRITE-NEEDLE");
	});

	test("Collapsed mode draws every card header-only until it is open", () => {
		expect(render(bashCall())).toContain("ZZ-BASH-NEEDLE");
		setState("display", "toolCards", "collapsed");
		expect(render(bashCall())).not.toContain("ZZ-BASH-NEEDLE");
		setState("toolsExpanded", true);
		expect(render(bashCall())).toContain("ZZ-BASH-NEEDLE");
	});
});

describe("JsonTree", () => {
	const value = { top: { middle: { bottom: "deep-leaf" }, side: 1 }, flat: "flat-leaf" };
	const html = (openDepth?: number) =>
		renderToString(() => createComponent(JsonTree, { value, openDepth }));

	test("only the open levels mount their entries", () => {
		const root = html();
		expect(root).toContain("flat-leaf");
		expect(root).toContain("top");
		// `top` starts closed, so its children are not in the DOM yet.
		expect(root).not.toContain("middle");
		expect(root).not.toContain("deep-leaf");
		expect(html(2)).toContain("middle");
		expect(html(2)).not.toContain("deep-leaf");
		expect(html(3)).toContain("deep-leaf");
	});
});

describe("EvalTable", () => {
	const columns = [{ head: "n", numeric: true }];
	const rows = Array.from({ length: 250 }, (_, i) => [String(i)]);

	test("draws the first rows and offers the rest", () => {
		const html = renderToString(() => createComponent(EvalTable, { columns, rows }));
		// Header row, the first 100 body rows and the "more rows" row.
		expect(html.match(/<tr\b/g)).toHaveLength(102);
		expect(html).toContain("150 more rows");
		expect(html).not.toContain(">249<");
	});

	test("a table within the cap has no button", () => {
		const html = renderToString(() =>
			createComponent(EvalTable, { columns, rows: rows.slice(0, 100) }),
		);
		expect(html).not.toContain("more rows");
	});
});
