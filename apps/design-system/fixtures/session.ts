import type { SubagentInfo } from "../../web/state";

/** Fixed epoch so retry countdowns and timestamps look the same on every load. */
export const FIXTURE_NOW = Date.parse("2026-10-09T12:00:00Z");

export const subagentFixtures: SubagentInfo[] = [
	{
		id: "sub-1",
		index: 0,
		agent: "scout",
		description: "Map the tool-card components",
		status: "running",
		lastUpdate: FIXTURE_NOW,
	},
	{
		id: "sub-2",
		index: 1,
		agent: "task",
		description: "Add the retry badge",
		status: "done",
		lastUpdate: FIXTURE_NOW - 60_000,
	},
];

/** Keyed like state.subagents; stories seed it by value (seeds are cloned on apply). */
export const subagentMap = new Map(subagentFixtures.map((sub) => [sub.id, sub]));
