import { TranscriptStream } from "../../../../web/components/chat/transcript/TranscriptStream";
import type { DisplayPrefs } from "../../../../web/prefs/display";
import { setState, state, type ChatItem } from "../../../../web/state";
import { assistantBlocks } from "../../../../web/store/chat";
import { answerCalls } from "../../../session";
import { screenItems, screenSessionSeed } from "../../../fixtures/screen";
import { subagentTranscriptItems } from "../../../fixtures/subagents";
import {
	bashDoneTool,
	bashErrorTool,
	bashRunningTool,
	editToolItem,
	globDoneTool,
	grepDoneTool,
	readDoneTool,
	taskDoneTool,
	todoArgsTool,
	waitJobDetail,
	waitRunItems,
} from "../../../fixtures/tools";
import { defineStory } from "../../../registry";
import { closeDock } from "../../../../web/store/dock";
import { openActivities } from "../../../../web/store/activities";

const idleLive = { active: false, blocks: [] };

/** Built through the store's mapping so the story exercises it: one reasoning block, one narration block. */
const narrationItems: ChatItem[] = [
	{
		kind: "user",
		id: 1,
		text: "Rename `fetchUser` to `loadUser` across the app.",
	},
	{
		kind: "assistant",
		id: 2,
		blocks: assistantBlocks([
			{
				type: "thinking",
				thinking: "A rename touches every caller. I should list them before editing.",
				thinkingSignature: "sig-reasoning",
			},
			{
				type: "thinking",
				thinking: "Found 4 callers in `apps/web`. Renaming the export first, then each import.",
				thinkingSignature: "sig-narration",
				narration: true,
			},
			{ type: "text", text: "Renamed `fetchUser` to `loadUser` in all 4 callers." },
		]),
	},
];

/**
 * One turn mixing visible cards (a short bash call, assistant replies) with every card the open
 * Activities panel hides: a task, a todo update, a backgrounded bash call and a wait run.
 */
const activityCardItems: ChatItem[] = [
	{ kind: "user", id: 9300, text: "Plan the migration, build in the background and wait for it." },
	{
		kind: "assistant",
		id: 9301,
		blocks: [{ kind: "text", text: "Checking the tree, then splitting the work." }],
	},
	{ ...bashDoneTool, id: 9302, toolCallId: "call_ac_status" },
	{ ...todoArgsTool, id: 9303, toolCallId: "call_ac_todo" },
	{ ...taskDoneTool, id: 9304, toolCallId: "call_ac_task" },
	{
		kind: "assistant",
		id: 9305,
		blocks: [{ kind: "text", text: "Agents finished; starting the build in the background." }],
	},
	{
		kind: "tool",
		id: 9306,
		toolCallId: "call_ac_bash_bg",
		name: "bash",
		args: { command: "bun run build:web", async: true },
		status: "done",
		output: "Started background job bg_build.",
		details: { async: { state: "running", jobId: "bg_build", type: "bash" } },
		background: {
			jobId: "bg_build",
			type: "bash",
			state: "running",
			jobIds: ["bg_build"],
			startedAt: Date.now() - 90_000,
		},
	},
	...waitRunItems.slice(3).map((item, index) => ({ ...item, id: 9310 + index })),
];

/**
 * One turn of tool calls for the tool card modes: reasoning and a note, five calls (one failing; a
 * message of reasoning only sits between two of them), a closing message, a second run that ends on a call still running, then the user's next message.
 */
const toolRunItems: ChatItem[] = [
	{
		kind: "user",
		id: 9400,
		text: "Find where COPY_FEEDBACK_MS is used and tighten the copy button.",
	},
	{
		kind: "assistant",
		id: 9401,
		duration: 4200,
		blocks: [
			{
				kind: "thinking",
				text: "I should grep for the constant, list the tool cards, then read the button before editing.",
			},
			{ kind: "text", text: "Searching the tree first." },
		],
	},
	{ ...readDoneTool, id: 9402, toolCallId: "call_tr_read" },
	{
		kind: "assistant",
		id: 9410,
		duration: 1800,
		blocks: [{ kind: "thinking", text: "Now the usages of the constant." }],
	},
	{ ...grepDoneTool, id: 9403, toolCallId: "call_tr_grep" },
	{ ...globDoneTool, id: 9404, toolCallId: "call_tr_glob" },
	{ ...editToolItem, id: 9405, toolCallId: "call_tr_edit" },
	{ ...bashErrorTool, id: 9406, toolCallId: "call_tr_bash_err" },
	{
		kind: "assistant",
		id: 9407,
		blocks: [
			{ kind: "text", text: "The type check failed; checking git state and re-running it." },
		],
	},
	{ ...bashDoneTool, id: 9408, toolCallId: "call_tr_bash" },
	{ ...bashRunningTool, id: 9409, toolCallId: "call_tr_bash_run" },
];

/** The session seed over the tool call turn, with the Appearance sheet's tool card choices applied. */
function seedToolRuns(display: Partial<DisplayPrefs>): void {
	setState({ ...screenSessionSeed, items: toolRunItems, live: idleLive, streaming: false });
	setState("display", display);
}

export default defineStory({
	id: "chat-transcript-transcript-stream",
	title: "TranscriptStream",
	component: {
		file: "apps/web/components/chat/transcript/TranscriptStream.tsx",
		export: "TranscriptStream",
	},
	variants: [
		{
			name: "Agent: running",
			description:
				"`variant` agent over a subagent's items: the first user message (the assignment) folds behind Show all, calls pair with their results, and a call without a result shows as running. No branch-from-here.",
			render: () => (
				<div class="ds-frame ds-frame-tall ds-frame-column">
					<TranscriptStream
						items={subagentTranscriptItems("FixtureBuilder")}
						variant="agent"
						class="subagent-transcript"
					/>
				</div>
			),
		},
		{
			name: "Agent: short assignment",
			description: "An assignment that fits in a few lines is not folded, so there is no Show all.",
			render: () => (
				<div class="ds-frame ds-frame-tall ds-frame-column">
					<TranscriptStream
						items={subagentTranscriptItems("FixtureBuilder.ChatMap")}
						variant="agent"
						class="subagent-transcript"
					/>
				</div>
			),
		},
		{
			name: "Session",
			description:
				"`variant` session over the main transcript: branch-from-here on user cards, nothing folded, and the live turn and working shimmer when streaming.",
			seed: { ...screenSessionSeed, items: screenItems, live: idleLive, streaming: false },
			render: () => (
				<div class="ds-frame ds-frame-tall ds-frame-column">
					<TranscriptStream items={state.items} variant="session" />
				</div>
			),
		},
		{
			name: "Session: narration",
			description:
				"An assistant message whose second thinking block carries `narration: true` (Anthropic prose between tool calls). Blocks come from the store's `assistantBlocks`: the reasoning block folds under thinking, the narration reads as reply text, as in the TUI.",
			seed: {
				...screenSessionSeed,
				items: narrationItems,
				live: idleLive,
				streaming: false,
			},
			render: () => (
				<div class="ds-frame ds-frame-tall ds-frame-column">
					<TranscriptStream items={state.items} variant="session" />
				</div>
			),
		},
		{
			name: "Session: folded wait run",
			description:
				"The turn starts a build in the background and then waits four times, with assistant turns that draw nothing between the waits. The four calls fold into one wait card at the first (the build row's arrow jumps to the bash card that started it); the closing message ends the run.",
			seed: () => answerCalls({ getJobDetail: () => structuredClone(waitJobDetail) }),
			render: () => (
				<div class="ds-frame ds-frame-tall ds-frame-column">
					<TranscriptStream items={waitRunItems} variant="session" />
				</div>
			),
		},
		{
			name: "Session: Activities panel open",
			description:
				"With the Activities panel open the main transcript hides the cards it shows as sections: the task call, the todo update, the backgrounded bash call and the whole wait run. The short bash call and the messages stay. Close restores them in place; the stream keeps its scroll position.",
			seed: () => {
				answerCalls({ getJobDetail: () => structuredClone(waitJobDetail) });
				openActivities();
			},
			render: () => (
				<div class="ds-frame ds-frame-tall ds-frame-column">
					<div class="review-actions">
						<button type="button" onClick={() => openActivities()}>
							Open Activities
						</button>
						<button type="button" onClick={closeDock}>
							Close
						</button>
					</div>
					<TranscriptStream items={activityCardItems} variant="session" />
				</div>
			),
		},
		{
			name: "Session: tool cards collapsed",
			description:
				"Tool cards Collapsed: every call is a header-only card, specialised ones included. A click opens one; the running call stays open.",
			seed: () => seedToolRuns({ toolCards: "collapsed" }),
			render: () => (
				<div class="ds-frame ds-frame-tall ds-frame-column">
					<TranscriptStream items={state.items} variant="session" />
				</div>
			),
		},
		{
			name: "Session: tool cards consolidated",
			description:
				"Tool cards Consolidated: each run of consecutive calls is one summary row. The first run folds the reasoning of the message before it (its text stays); the second run's running call shows under its row until it finishes. A click opens a run to header-only cards.",
			seed: () => seedToolRuns({ toolCards: "consolidated" }),
			render: () => (
				<div class="ds-frame ds-frame-tall ds-frame-column">
					<TranscriptStream items={state.items} variant="session" />
				</div>
			),
		},
		{
			name: "Session: tool cards expanded, 10 rows",
			description:
				"Tool cards Expanded with the Rows choice at 10: output past 10 rows hides behind a Show hidden lines button (the tail for bash and eval, the head for read; Ctrl+O shows all).",
			seed: () => seedToolRuns({ toolCards: "expanded", toolRows: "10" }),
			render: () => (
				<div class="ds-frame ds-frame-tall ds-frame-column">
					<TranscriptStream items={state.items} variant="session" />
				</div>
			),
		},
	],
});
