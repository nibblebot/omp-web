import { onMount, type JSX } from "solid-js";
import { ActivityBar } from "../../../web/components/activities/ActivityBar";
import { setState, type state } from "../../../web/state";
import { seedActivityBar, type ActivityBarParts } from "../../fixtures/activity-bar";
import { defineStory } from "../../registry";

/** The composer column's foot: the bar sits where it does above the composer (`top` puts it at the head instead). */
const frame = (top = false): JSX.Element => (
	<div class={`ds-frame app-main ds-frame-bar${top ? " ds-frame-bar-top" : ""}`}>
		<ActivityBar />
	</div>
);

/** Presses the button titled `title` once mounted, as a user does to open its popover. */
function Press(props: { title: string; children: JSX.Element }): JSX.Element {
	let host: HTMLDivElement | undefined;
	onMount(() => host?.querySelector<HTMLButtonElement>(`button[title^="${props.title}"]`)?.click());
	return <div ref={(el) => (host = el)}>{props.children}</div>;
}

const ALL: ActivityBarParts = {
	subagents: "running",
	jobs: "running",
	daemons: true,
	todos: "mid-run",
};

const seed =
	(parts: ActivityBarParts, turn: Partial<typeof state> = {}) =>
	() => {
		seedActivityBar(parts);
		setState(turn);
	};

export default defineStory({
	id: "activities-activity-bar",
	title: "ActivityBar",
	component: { file: "apps/web/components/activities/ActivityBar.tsx", export: "ActivityBar" },
	variants: [
		{
			name: "Idle, nothing listed",
			description:
				"No text and no buttons: the strip has collapsed to zero height, so the frame is empty.",
			seed: seed({}),
			render: () => frame(),
		},
		{
			name: "Working",
			description:
				"The agent streams and has named its intent: the shimmer label sits on the left, one line.",
			seed: seed({}, { streaming: true, workingIntent: "Reading the config loader" }),
			render: () => frame(),
		},
		{
			name: "Working, default text",
			description: "Streaming before the first tool intent lands: the TUI's default phrase.",
			seed: seed({}, { streaming: true }),
			render: () => frame(),
		},
		{
			name: "Working, long text",
			description:
				"An intent longer than the row truncates with an ellipsis; the buttons keep their room.",
			seed: seed(ALL, {
				streaming: true,
				workingIntent:
					"Reconciling the roster frames with the persisted layout, then replaying the queued steering messages against the new attach",
			}),
			render: () => frame(),
		},
		{
			name: "Compacting",
			description:
				"Compaction replaces the working text; the strip reads as activity, not a warning.",
			seed: seed({}, { compacting: true }),
			render: () => frame(),
		},
		{
			name: "All sections running",
			description:
				"Subagents, Jobs, Daemons and Todo in that order. Badges count what is active (Todo shows done/total); the first button's title carries the Alt+A hint.",
			seed: seed(ALL, { streaming: true, workingIntent: "Wiring the activity bar" }),
			render: () => frame(),
		},
		{
			name: "Subagents only",
			description: "A section with nothing listed has no button.",
			seed: seed({ subagents: "running" }),
			render: () => frame(),
		},
		{
			name: "Everything settled",
			description:
				"Finished items still count: the buttons stay, muted, and the counted ones show no badge while nothing is active.",
			seed: seed({ subagents: "settled", jobs: "settled", todos: "done" }),
			render: () => frame(),
		},
		{
			name: "Subagents popover",
			description: "Opened above its button, aligned to the button's right edge.",
			seed: seed(ALL),
			render: () => <Press title="Subagents">{frame()}</Press>,
		},
		{
			name: "Jobs popover",
			description: "Opened above its button; only one popover is open at a time.",
			seed: seed(ALL),
			render: () => <Press title="Jobs">{frame()}</Press>,
		},
		{
			name: "Daemons popover",
			description: "Opened above its button.",
			seed: seed(ALL),
			render: () => <Press title="Daemons">{frame()}</Press>,
		},
		{
			name: "Todo popover",
			description: "Opened above its button.",
			seed: seed(ALL),
			render: () => <Press title="Todo">{frame()}</Press>,
		},
		{
			name: "Popover flips below near the top",
			description:
				"The strip at the head of its frame. With under about 240px of viewport above its button the popover opens below it instead (shrink the window or scroll the page until the frame nears the top; the popover follows).",
			seed: seed(ALL),
			render: () => <Press title="Subagents">{frame(true)}</Press>,
		},
	],
});
