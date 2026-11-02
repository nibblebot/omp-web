/**
 * `out://` replies on tool cards: which calls carry them, which `write` is a reply, and what the
 * transcript draws. Rendered through solid's SSR runtime, so the HTML is what the card would put in
 * the DOM; the Markdown body (sanitized through DOMPurify, which needs a DOM) is stood in for by its source.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { groupToolRuns } from "../../chat/tool-runs";
import { isReplyWrite, repliesOf, replyWriteText } from "../../chat/tool-replies";
import { ToolRunRow } from "../../components/chat/transcript/cards/ToolRunRow";
import { ToolCard } from "../../components/chat/tools/ToolCard";
import { RunMemberContext } from "../../components/chat/tools/ToolCardShell";
import { Markdown } from "../../components/ui/Markdown";
import { loadHistory, setState, state, type ChatItem, type ToolItem } from "../../state";
import { installJsxShim, restoreJsxShim } from "../web.testkit";

const original = { toolsExpanded: state.toolsExpanded, toolCards: state.display.toolCards };

beforeEach(() => {
	installJsxShim({
		onElement: (type, props) =>
			type === Markdown ? { value: `<div class="md">MD[${String(props.src)}]</div>` } : undefined,
	});
	setState("toolsExpanded", false);
	setState("display", "toolCards", original.toolCards);
});

afterAll(() => {
	restoreJsxShim();
	setState("toolsExpanded", original.toolsExpanded);
	setState("display", "toolCards", original.toolCards);
});

let nextId = 1;
const call = (name: string, over: Partial<ToolItem> = {}): ToolItem => ({
	kind: "tool",
	id: nextId,
	toolCallId: `call_${nextId++}`,
	name,
	args: {},
	status: "done",
	output: "",
	...over,
});
const bash = (over: Partial<ToolItem> = {}) =>
	call("bash", { args: { command: "echo hi" }, output: "ZZ-BASH-NEEDLE", ...over });
const replyWrite = (over: Partial<ToolItem> = {}) =>
	call("write", { args: { path: "out://status.md", content: "ZZ-REPLY-NEEDLE" }, ...over });

const render = (item: ToolItem) => renderToString(() => createComponent(ToolCard, { item }));
const replyBlocks = (html: string) =>
	html.match(/class="msg-assistant tool-reply\s*"/g)?.length ?? 0;
const markdownBlocks = (html: string) => html.match(/class="md"/g)?.length ?? 0;

describe("repliesOf", () => {
	test("a running call shows its live replies, a settled one its details'", () => {
		expect(repliesOf(bash({ status: "running", replies: ["a"] }))).toEqual(["a"]);
		expect(repliesOf(bash({ status: "running", details: { replies: ["settled"] } }))).toEqual([]);
		expect(repliesOf(bash({ details: { replies: ["a", "b"] }, replies: ["a"] }))).toEqual([
			"a",
			"b",
		]);
	});

	test("a settled call without reply details falls back to the live ones", () => {
		expect(repliesOf(bash({ details: {}, replies: ["live"] }))).toEqual(["live"]);
		expect(repliesOf(bash({ details: undefined }))).toEqual([]);
	});

	test("blank and non-string entries are not replies, and only bash and eval carry them", () => {
		expect(repliesOf(bash({ details: { replies: ["  ", 3, "kept"] } }))).toEqual(["kept"]);
		expect(repliesOf(call("eval", { details: { replies: ["cell"] } }))).toEqual(["cell"]);
		expect(repliesOf(call("grep", { details: { replies: ["no"] } }))).toEqual([]);
	});
});

describe("isReplyWrite", () => {
	test("a write to an out:// URL is a reply, any other write or tool is not", () => {
		expect(isReplyWrite(replyWrite())).toBe(true);
		expect(isReplyWrite(call("write", { args: { file_path: "OUT://x.md", content: "hi" } }))).toBe(
			true,
		);
		expect(isReplyWrite(call("write", { args: { path: "notes/out://x", content: "hi" } }))).toBe(
			false,
		);
		expect(isReplyWrite(call("write", { args: { path: "notes.md", content: "hi" } }))).toBe(false);
		expect(isReplyWrite(call("write", { args: null }))).toBe(false);
		expect(isReplyWrite(call("edit", { args: { path: "out://x.md" } }))).toBe(false);
	});

	test("the reply text is the call's content", () => {
		expect(replyWriteText(replyWrite())).toBe("ZZ-REPLY-NEEDLE");
		expect(replyWriteText(call("write", { args: { path: "out://x.md" } }))).toBe("");
	});
});

describe("ToolCard replies", () => {
	test("a bash call's replies follow its card, one block each", () => {
		const html = render(bash({ details: { replies: ["first", "second"] } }));
		expect(html).toContain("ZZ-BASH-NEEDLE");
		expect(replyBlocks(html)).toBe(1);
		expect(markdownBlocks(html)).toBe(2);
		expect(html).toContain("MD[first]");
		expect(html).toContain("MD[second]");
		expect(html.indexOf("ZZ-BASH-NEEDLE")).toBeLessThan(html.indexOf("tool-reply"));
	});

	test("a running eval call shows the replies it has so far", () => {
		const html = render(call("eval", { status: "running", replies: ["one"], args: { code: "x" } }));
		expect(replyBlocks(html)).toBe(1);
		expect(markdownBlocks(html)).toBe(1);
	});

	test("cards without replies are unchanged", () => {
		expect(replyBlocks(render(bash()))).toBe(0);
		expect(replyBlocks(render(bash({ details: { exitCode: 0 } })))).toBe(0);
		expect(replyBlocks(render(call("grep", { details: { replies: ["x"] } })))).toBe(0);
	});

	test("a run member leaves its replies to the run row, which draws them while closed", () => {
		const item = bash({ details: { replies: ["x"] } });
		const member = renderToString(() =>
			createComponent(RunMemberContext.Provider, {
				value: true,
				get children() {
					return createComponent(ToolCard, { item });
				},
			}),
		);
		expect(replyBlocks(member)).toBe(0);

		const run = {
			key: item.id,
			tools: [item, bash()],
			thinking: [],
			consumedAssistantIds: [],
			turnCount: 0,
			requestCount: 2,
			errorCount: 0,
			durationMs: 0,
			running: false,
		};
		const row = () =>
			renderToString(() =>
				createComponent(ToolRunRow, { run, waitRuns: { get: () => undefined } }),
			);
		const closed = row();
		expect(closed).toContain("run-row");
		expect(replyBlocks(closed)).toBe(1);
		expect(closed).toContain("MD[x]");
		expect(closed).not.toContain("ZZ-BASH-NEEDLE");
		expect(closed.indexOf("run-row")).toBeLessThan(closed.indexOf("tool-reply"));

		setState("toolsExpanded", true);
		// The JSX shim evaluates children eagerly, so the members' context is not seen here (the member case above covers it).
		expect(row()).toContain("ZZ-BASH-NEEDLE");
	});

	test("a write to out:// is prose, with no Write card", () => {
		const html = render(replyWrite());
		expect(replyBlocks(html)).toBe(1);
		expect(markdownBlocks(html)).toBe(1);
		expect(html).toContain("MD[ZZ-REPLY-NEEDLE]");
		expect(html).not.toContain("tool-card");
		expect(html).not.toContain("out://status.md");
	});

	test("a refused reply write shows its error, an empty running one nothing", () => {
		const failed = render(replyWrite({ status: "error", output: "out:// is off in this session" }));
		expect(failed).toContain("out:// is off in this session");
		expect(failed).toContain("tool-reply-error");
		expect(render(replyWrite({ status: "running", args: { path: "out://" } }))).not.toContain(
			"msg-assistant",
		);
	});

	test("a write to a file still draws the Write card", () => {
		const html = render(call("write", { args: { path: "notes.md", content: "hi" } }));
		expect(html).toContain("tool-card");
		expect(replyBlocks(html)).toBe(0);
	});
});

describe("tool runs", () => {
	const assistant = (id: number): ChatItem => ({
		kind: "assistant",
		id,
		blocks: [{ kind: "text", text: "" }],
	});

	test("a reply write ends a run instead of joining it", () => {
		const items: ChatItem[] = [
			call("read"),
			assistant(900),
			replyWrite(),
			assistant(901),
			call("grep"),
			call("glob"),
		];
		const runs = groupToolRuns(items);
		expect(runs.map((run) => run.tools.map((tool) => tool.name))).toEqual([
			["read"],
			["grep", "glob"],
		]);
	});
});

describe("history", () => {
	afterEach(() => setState("items", []));

	test("a reload draws the replies the settled results carry", () => {
		loadHistory([
			{ role: "user", content: "go", timestamp: 1 },
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "c_bash",
						name: "bash",
						arguments: { command: "x > out://a.md" },
					},
					{
						type: "toolCall",
						id: "c_write",
						name: "write",
						arguments: { path: "out://b.md", content: "from a write" },
					},
				],
				stopReason: "toolUse",
			},
			{
				role: "toolResult",
				toolCallId: "c_bash",
				toolName: "bash",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				details: { replies: ["from a command"] },
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "c_write",
				toolName: "write",
				content: [{ type: "text", text: "Wrote out://b.md" }],
				isError: false,
				timestamp: 3,
			},
		] as unknown as Parameters<typeof loadHistory>[0]);
		const tools = state.items.filter((item): item is ToolItem => item.kind === "tool");
		expect(tools.map((item) => repliesOf(item))).toEqual([["from a command"], []]);
		expect(tools.map((item) => isReplyWrite(item))).toEqual([false, true]);
		expect(replyBlocks(render(tools[0]!))).toBe(1);
		expect(render(tools[1]!)).toContain("MD[from a write]");
	});
});
