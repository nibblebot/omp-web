import type { SessionListEntry } from "#lib/wire/protocol";
import { EmptyTranscript } from "../../../../web/components/chat/transcript/EmptyTranscript";
import { setState } from "../../../../web/state";
import { settleWorkspaceSessions } from "../../../../web/store/roster";
import { answerCommands } from "../../../session";
import { rosterSessions } from "../../../fixtures/roster";
import { screenSessionSeed } from "../../../fixtures/screen";
import { defineStory } from "../../../registry";

/**
 * The workspace's earlier sessions as the session lists them: one failed turn (status dot),
 * one unnamed session titled by its first prompt, and one empty session the screen hides.
 */
const recentSessions = (): SessionListEntry[] => {
	const [latest, middle, unnamed] = rosterSessions(Date.now());
	if (!latest || !middle || !unnamed) return [];
	return [
		{ ...latest, status: "complete" },
		{ ...middle, status: "error" },
		{
			...unnamed,
			firstMessage: "Why does the sidebar flash when a worktree wakes up?",
			status: "complete",
		},
		{ ...unnamed, id: "sess_empty0000", path: `${unnamed.path}.empty`, messageCount: 0 },
	];
};

/** A loaded session with no messages, answering the workspace's session list with `sessions`. */
const seedEmpty = (sessions: () => SessionListEntry[] | null, synced = true) => {
	answerCommands({
		list_workspace_sessions: (cmd) => {
			const list = sessions();
			if (cmd.type === "list_workspace_sessions" && list !== null) {
				settleWorkspaceSessions(cmd.workspaceId, list, cmd.limit);
			}
		},
	});
	setState({
		...screenSessionSeed,
		items: [],
		live: { active: false, blocks: [] },
		streaming: false,
		messageCount: 0,
		modelSynced: synced,
	});
};

const frame = () => (
	<div class="ds-frame ds-frame-tall app-main">
		<EmptyTranscript />
	</div>
);

export default defineStory({
	id: "chat-transcript-empty-transcript",
	title: "EmptyTranscript",
	component: {
		file: "apps/web/components/chat/transcript/EmptyTranscript.tsx",
		export: "EmptyTranscript",
	},
	variants: [
		{
			name: "Recent sessions",
			description:
				"A fresh worktree session: project, branch and model, key hints, and the workspace's earlier sessions to resume.",
			seed: () => seedEmpty(recentSessions),
			render: frame,
		},
		{
			name: "No earlier sessions",
			description: "Nothing to resume: the recent list is hidden, not shown empty.",
			seed: () => seedEmpty(() => []),
			render: frame,
		},
		{
			name: "Recent sessions loading",
			description: "The session list request is still in flight: no list and no spinner.",
			seed: () => seedEmpty(() => null),
			render: frame,
		},
		{
			name: "Waiting for the model",
			description:
				"Before the state frame lands the model label is withheld; the rest of the header shows.",
			seed: () => seedEmpty(recentSessions, false),
			render: frame,
		},
	],
});
