/** The cards the main transcript hides while the Activities panel is open (`hiddenWhileActivitiesOpen`). */
import { describe, expect, test } from "bun:test";
import type { ChatItem, ToolItem } from "../../state";
import { hiddenWhileActivitiesOpen } from "../../chat/activity-cards";
import { buildWaitRuns, type WaitFoldOptions } from "../../chat/wait-runs";

const SHOWN: WaitFoldOptions = {
	hideThinking: false,
	proseOnlyThinking: true,
	showTokenUsage: false,
	turnMeta: new Map(),
};

let nextId = 1;

function tool(name: string, over: Partial<ToolItem> = {}): ToolItem {
	const id = nextId++;
	return {
		kind: "tool",
		id,
		toolCallId: `c${id}`,
		name,
		args: {},
		status: "done",
		output: "",
		...over,
	};
}

const background = {
	jobId: "j1",
	type: "bash",
	state: "running" as const,
	jobIds: ["j1"],
	startedAt: 0,
};
const user = (): ChatItem => ({ kind: "user", id: nextId++, text: "go" });
const assistant = (): ChatItem => ({ kind: "assistant", id: nextId++, blocks: [] });

const drawn = (items: readonly ChatItem[]) =>
	items.filter((item) => !hiddenWhileActivitiesOpen(item));

describe("hiddenWhileActivitiesOpen", () => {
	test("open panel drops task, todo, wait and backgrounded tool cards", () => {
		const keep = [
			user(),
			tool("bash"),
			tool("read"),
			assistant(),
			tool("eval", { status: "running" }),
		];
		const hide = [
			tool("task"),
			tool("todo"),
			tool("wait"),
			tool("bash", { background }),
			tool("eval", { background }),
		];
		const items = [
			keep[0]!,
			hide[0]!,
			keep[1]!,
			hide[1]!,
			hide[2]!,
			keep[2]!,
			hide[3]!,
			keep[3]!,
			hide[4]!,
			keep[4]!,
		];
		expect(drawn(items)).toEqual(keep);
		for (const item of hide) expect(hiddenWhileActivitiesOpen(item)).toBe(true);
		for (const item of keep) expect(hiddenWhileActivitiesOpen(item)).toBe(false);
	});

	test("a card flips as its job settles into or out of the background", () => {
		const bash = tool("bash");
		expect(hiddenWhileActivitiesOpen(bash)).toBe(false);
		bash.background = background;
		expect(hiddenWhileActivitiesOpen(bash)).toBe(true);
		bash.background = undefined;
		expect(hiddenWhileActivitiesOpen(bash)).toBe(false);
	});

	test("wait runs computed on the full list still fold across hidden items", () => {
		const w1 = tool("wait", { status: "running" });
		const w2 = tool("wait", { status: "running" });
		const items = [user(), w1, assistant(), w2];
		const runs = buildWaitRuns(items, SHOWN);
		const run = runs.get(w1.id)!;
		expect(run.items).toEqual([w1, w2]);
		expect(runs.get(w2.id)).toBe(run);
		expect(drawn(items).some((i) => i.kind === "tool")).toBe(false);
	});
});
