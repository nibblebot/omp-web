import { ResumePicker } from "../../../web/components/sessions/ResumePicker";
import { SessionPicker } from "../../../web/components/sessions/SessionPicker";
import { settleSessions } from "../../../web/store/roster";
import { setState } from "../../../web/state";
import {
	foreignSessionPreviews,
	resumeCandidates,
	sessionListEntries,
} from "../../fixtures/overlays";
import { answerCalls, answerCommands } from "../../daemon";
import { defineStory } from "../../registry";

const pending = () => Promise.withResolvers<unknown>().promise;

export default [
	defineStory({
		id: "sessions-resume-picker",
		title: "ResumePicker",
		component: { file: "apps/web/components/sessions/ResumePicker.tsx", export: "ResumePicker" },
		tabs: true,
		seed: { currentSessionId: "sess_09a41c" },
		variants: [
			{
				name: "Sessions and foreign history",
				description: "Native sessions plus Claude and Codex sessions available to import.",
				seed: () =>
					answerCalls({
						resumeList: () => ({ candidates: resumeCandidates }),
						foreignList: () => ({ sessions: foreignSessionPreviews }),
					}),
				render: (ctx) => <ResumePicker onClose={ctx.close} />,
			},
			{
				name: "Loading",
				seed: () =>
					answerCalls({
						resumeList: pending,
						foreignList: pending,
					}),
				render: (ctx) => <ResumePicker onClose={ctx.close} />,
			},
			{
				name: "Search failed",
				seed: () =>
					answerCalls({
						resumeList: () => {
							throw new Error("Session index is being rebuilt");
						},
						foreignList: () => ({ sessions: [] }),
					}),
				render: (ctx) => <ResumePicker onClose={ctx.close} />,
			},
		],
	}),
	defineStory({
		id: "sessions-session-picker",
		title: "SessionPicker",
		component: { file: "apps/web/components/sessions/SessionPicker.tsx", export: "SessionPicker" },
		tabs: true,
		seed: { currentSessionId: "sess_09a41c" },
		variants: [
			{
				name: "Resume session",
				description: "Recent sessions for this workspace, newest first.",
				seed: () => answerCommands({ list_sessions: () => settleSessions(sessionListEntries) }),
				render: (ctx) => <SessionPicker onClose={ctx.close} />,
			},
			{
				name: "New session or resume",
				description: "Gate mode: a daemon has no attached session yet.",
				seed: () => {
					answerCommands({ list_sessions: () => settleSessions(sessionListEntries) });
					setState("sessionPickerGate", { daemonId: "daemon_local" });
				},
				render: (ctx) => <SessionPicker onClose={ctx.close} />,
			},
			{
				name: "Before the list arrives",
				description:
					"The daemon has not answered yet; the modal shows its empty note until it does.",
				// Accepted but never answered, like a daemon that has not replied yet.
				seed: () => answerCommands({ list_sessions: () => undefined }),
				render: (ctx) => <SessionPicker onClose={ctx.close} />,
			},
		],
	}),
];
