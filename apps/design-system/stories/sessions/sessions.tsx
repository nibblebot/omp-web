import { createSignal, untrack } from "solid-js";
import { ResumePicker } from "../../../web/components/sessions/ResumePicker";
import { SessionListPicker } from "../../../web/components/sessions/SessionListPicker";
import { SessionPicker } from "../../../web/components/sessions/SessionPicker";
import { SessionPickerRow } from "../../../web/components/sessions/SessionPickerRow";
import { searchResume, sessionRowsFromResume } from "../../../web/store/resume";
import { sessionDisplayTitle, type SessionRow } from "../../../web/store/session-list";
import { pushToast } from "../../../web/store/toasts";
import { setState } from "../../../web/state";
import {
	foreignSessionPreviews,
	resumeCandidates,
	resumeListReply,
	T0,
} from "../../fixtures/overlays";
import { answerCalls } from "../../daemon";
import { defineStory } from "../../registry";

const pending = () => Promise.withResolvers<unknown>().promise;

/** The attached session in every list story: the first fixture candidate. */
const ATTACHED_FILE = resumeCandidates[0].sessionFile;

const listRows = (): SessionRow[] => sessionRowsFromResume(resumeCandidates, ATTACHED_FILE);

/** Stateful host for SessionListPicker: the story owns the row data, as a real caller would. */
function SessionListStory(props: {
	rows: SessionRow[];
	loading?: boolean;
	canManage: boolean;
	emptyText?: string;
}) {
	const [rows, setRows] = createSignal<SessionRow[]>(untrack(() => props.rows));
	const [query, setQuery] = createSignal("");
	const [allProjects, setAllProjects] = createSignal(false);
	return (
		<SessionListPicker
			rows={rows()}
			total={rows().length}
			query={query()}
			onQuery={setQuery}
			loading={props.loading}
			allProjects={allProjects()}
			onAllProjects={setAllProjects}
			canManage={props.canManage}
			now={() => T0}
			emptyText={props.emptyText}
			onChoose={(row) => pushToast(`Resume ${sessionDisplayTitle(row)}`)}
			onTogglePin={(row) =>
				setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, pinned: !r.pinned } : r)))
			}
			onRename={(row, title) => {
				setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, title } : r)));
				return Promise.resolve(true);
			}}
			onDelete={(row) => {
				setRows((prev) => prev.filter((r) => r.id !== row.id));
				return Promise.resolve(true);
			}}
		/>
	);
}

export default [
	defineStory({
		id: "sessions-resume-picker",
		title: "ResumePicker",
		component: { file: "apps/web/components/sessions/ResumePicker.tsx", export: "ResumePicker" },
		tabs: true,
		seed: { currentSessionId: "sess_09a41c" },
		variants: [
			{
				name: "Import and resume by id",
				description: "Resume by id or profile, plus Claude and Codex sessions available to import.",
				seed: () => answerCalls({ foreignList: () => ({ sessions: foreignSessionPreviews }) }),
				render: (ctx) => <ResumePicker onClose={ctx.close} />,
			},
			{
				name: "Foreign history loading",
				seed: () => answerCalls({ foreignList: pending }),
				render: (ctx) => <ResumePicker onClose={ctx.close} />,
			},
			{
				name: "Foreign history failed",
				seed: () =>
					answerCalls({
						foreignList: () => {
							throw new Error("Claude history directory is unreadable");
						},
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
				description:
					"Pinned, today, and earlier sessions for this project; the attached session is shown but cannot be chosen.",
				seed: () => {
					answerCalls({ resumeList: () => resumeListReply });
					setState("sessionFile", ATTACHED_FILE);
					void searchResume("");
				},
				render: (ctx) => <SessionPicker onClose={ctx.close} />,
			},
			{
				name: "New session or resume",
				description: "Gate mode: a daemon has no attached session yet.",
				seed: () => {
					answerCalls({ resumeList: () => resumeListReply });
					setState("sessionPickerGate", { daemonId: "daemon_local" });
					void searchResume("");
				},
				render: (ctx) => <SessionPicker onClose={ctx.close} />,
			},
			{
				name: "Before the list arrives",
				description:
					"The daemon has not answered yet; the list shows its loading state until it does.",
				seed: () => {
					answerCalls({ resumeList: pending });
					void searchResume("");
				},
				render: (ctx) => <SessionPicker onClose={ctx.close} />,
			},
			{
				name: "Search failed",
				seed: () => {
					answerCalls({
						resumeList: () => {
							throw new Error("Session index is being rebuilt");
						},
					});
					void searchResume("");
				},
				render: (ctx) => <SessionPicker onClose={ctx.close} />,
			},
		],
	}),
	defineStory({
		id: "sessions-session-list-picker",
		title: "SessionListPicker",
		component: {
			file: "apps/web/components/sessions/SessionListPicker.tsx",
			export: "SessionListPicker",
		},
		tabs: true,
		variants: [
			{
				name: "Grouped with preview",
				description: "Pinned, today, and earlier groups with the preview pane and manage actions.",
				render: () => <SessionListStory rows={listRows()} canManage />,
			},
			{
				name: "Read only",
				description:
					"The daemon does not advertise rename and delete, so those actions are hidden.",
				render: () => <SessionListStory rows={listRows()} canManage={false} />,
			},
			{
				name: "No matches",
				render: () => (
					<SessionListStory rows={[]} canManage emptyText="No sessions match this search." />
				),
			},
			{
				name: "Loading",
				render: () => <SessionListStory rows={[]} loading canManage />,
			},
		],
	}),
	defineStory({
		id: "sessions-session-picker-row",
		title: "SessionPickerRow",
		component: {
			file: "apps/web/components/sessions/SessionPickerRow.tsx",
			export: "SessionPickerRow",
		},
		tabs: true,
		variants: [
			{
				name: "Pinned with first-prompt subtitle",
				render: () => (
					<SessionPickerRow
						row={listRows()[0]}
						active={false}
						showProject={false}
						nowMs={T0}
						onChoose={() => pushToast("Resume pinned session")}
						onTogglePin={() => pushToast("Unpin session")}
					/>
				),
			},
			{
				name: "Untitled, other project",
				description: "No title: the first prompt stands in; the project name is shown.",
				render: () => (
					<SessionPickerRow
						row={listRows()[1]}
						active
						showProject
						nowMs={T0}
						onChoose={() => pushToast("Resume session")}
						onTogglePin={() => pushToast("Pin session")}
					/>
				),
			},
			{
				name: "Attached session",
				description: "The attached session is shown but disabled as a resume target.",
				render: () => (
					<SessionPickerRow
						row={listRows()[0]}
						active={false}
						showProject={false}
						nowMs={T0}
						onChoose={() => pushToast("Resume session")}
					/>
				),
			},
		],
	}),
];
