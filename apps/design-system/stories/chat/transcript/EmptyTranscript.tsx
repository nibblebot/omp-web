import type { SessionListEntry } from "#lib/wire/protocol";
import { EmptyTranscript } from "../../../../web/components/chat/transcript/EmptyTranscript";
import { setState } from "../../../../web/state";
import { settleDaemonSessions } from "../../../../web/store/roster";
import { answerCommands } from "../../../daemon";
import { rosterSessions } from "../../../fixtures/roster";
import { screenSessionSeed } from "../../../fixtures/screen";
import { defineStory } from "../../../registry";

/** A loaded session with no messages, answering the workspace's session list with `sessions`. */
const seedEmpty = (sessions: () => SessionListEntry[] | null, synced = true) => {
	answerCommands({
		list_daemon_sessions: (cmd) => {
			const list = sessions();
			if (cmd.type === "list_daemon_sessions" && list !== null) {
				settleDaemonSessions(cmd.daemonId, list);
			}
		},
	});
	setState({
		...screenSessionSeed,
		items: [],
		live: { active: false, blocks: [], rev: 0 },
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
			seed: () => seedEmpty(() => rosterSessions(Date.now())),
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
			seed: () => seedEmpty(() => rosterSessions(Date.now()), false),
			render: frame,
		},
	],
});
