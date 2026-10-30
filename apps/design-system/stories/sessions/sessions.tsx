import { createMemo, createSignal, For, untrack } from "solid-js";
import {
	SessionListPicker,
	type SessionListPickerProps,
} from "../../../web/components/sessions/SessionListPicker";
import { SessionPicker } from "../../../web/components/sessions/SessionPicker";
import { SessionPickerRow } from "../../../web/components/sessions/SessionPickerRow";
import { searchResume, sessionRowsFromResume } from "../../../web/store/resume";
import {
	matchSessionRow,
	sessionDisplayTitle,
	type SessionRow,
} from "../../../web/store/session-list";
import { pushToast } from "../../../web/store/toasts";
import { setState } from "../../../web/state";
import { resumeCandidates, resumeListReply, T0 } from "../../fixtures/overlays";
import { answerCalls } from "../../session";
import { defineStory } from "../../registry";

const pending = () => Promise.withResolvers<unknown>().promise;

const MIN = 60_000;
const PROJECT_CWD = "/home/joshua/Repos/omp-web";

/** The attached session in every list story: the first fixture candidate. */
const ATTACHED_FILE = resumeCandidates[0].sessionFile;

const listRows = (): SessionRow[] => sessionRowsFromResume(resumeCandidates, ATTACHED_FILE);

/** A row with story defaults: complete, twelve messages, five minutes old, this project. */
const storyRow = (overrides: Partial<SessionRow> & { id: string }): SessionRow => ({
	file: `/home/joshua/.omp/sessions/omp-web/${overrides.id}.jsonl`,
	cwd: PROJECT_CWD,
	projectLabel: "omp-web",
	modifiedMs: T0 - 5 * MIN,
	messageCount: 12,
	status: "complete",
	pinned: false,
	scope: "local",
	...overrides,
});

const NORMAL = storyRow({
	id: "story_normal",
	title: "DEMO: Rework session list rows",
	firstMessage:
		"The resume list renders gray centered buttons; make it one clean line per session.",
});
const PINNED = storyRow({
	id: "story_pinned",
	title: "DEMO: Add fleet edge limit field",
	pinned: true,
});
const EMPTY = storyRow({
	id: "story_empty",
	messageCount: 0,
	firstMessage: "(no messages)",
	modifiedMs: T0 - 40 * MIN,
});
const CURRENT = storyRow({
	id: "story_current",
	title: "DEMO: Fix attached row highlight",
	current: true,
});
const ERRORED = storyRow({
	id: "story_error",
	title: "DEMO: Retry failed schema migration",
	status: "error",
	modifiedMs: T0 - 3 * 60 * MIN,
});
const INTERRUPTED = storyRow({
	id: "story_interrupted",
	title: "DEMO: Finish interrupted refactor",
	status: "interrupted",
	modifiedMs: T0 - 26 * 60 * MIN,
});
const BLOCKED = storyRow({
	id: "story_blocked",
	title: "DEMO: Try scratch experiment",
	cwd: "/home/you/scratch",
	projectLabel: "scratch",
	blocked: {
		reason: "No registered project owns this folder. Add it as a project to resume.",
		addProjectPath: "/home/you/scratch",
	},
});
const LONG = storyRow({
	id: "story_long",
	title:
		"DEMO: A very long session title that has to truncate with an ellipsis instead of wrapping the row",
	cwd: "/home/joshua/Repos/another-project",
	projectLabel: "another-project",
	modifiedMs: T0 - 9 * 24 * 60 * MIN,
});

const chooseToast = (row: SessionRow) => pushToast(`Resume ${sessionDisplayTitle(row)}`);

/** Stateful host for SessionListPicker: the story owns the row data, as a real caller would. */
function SessionListStory(
	props: {
		rows: SessionRow[];
		total?: number;
		loading?: boolean;
		scope?: boolean;
	} & Partial<
		Pick<SessionListPickerProps, "canManage" | "actions" | "note" | "emptyText" | "currentCwd">
	>,
) {
	const [rows, setRows] = createSignal<SessionRow[]>(untrack(() => props.rows));
	const [query, setQuery] = createSignal("");
	const [allProjects, setAllProjects] = createSignal(false);
	const shown = createMemo(() => rows().filter((row) => matchSessionRow(row, query())));
	return (
		<SessionListPicker
			rows={shown()}
			total={props.total ?? shown().length}
			note={props.note}
			query={query()}
			onQuery={setQuery}
			loading={props.loading}
			allProjects={props.scope ? allProjects() : undefined}
			onAllProjects={props.scope ? setAllProjects : undefined}
			currentCwd={props.currentCwd}
			actions={props.actions}
			canManage={props.canManage ?? false}
			now={() => T0}
			emptyText={props.emptyText}
			onChoose={chooseToast}
			onRename={(row, title) => {
				setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, title } : r)));
				return Promise.resolve(true);
			}}
			onDelete={(row) => {
				setRows((prev) => prev.filter((r) => r.id !== row.id));
				return Promise.resolve(true);
			}}
			onAddProject={() => pushToast("Add project")}
		/>
	);
}

/** A single full-size row in a dialog-body panel. */
const FullRow = (props: { row: SessionRow; showProject?: boolean; active?: boolean }) => (
	<div class="ds-frame ds-frame-panel">
		<SessionPickerRow
			row={props.row}
			size="full"
			active={props.active}
			showProject={props.showProject}
			nowMs={T0}
			onChoose={() => chooseToast(props.row)}
			onAddProject={() => pushToast("Add project")}
		/>
	</div>
);

/** Compact rows stacked in a host of the given frame class, as the sidebar and empty screen place them. */
const CompactRows = (props: { frame: string; rows: SessionRow[] }) => (
	<div class={props.frame}>
		<For each={props.rows}>
			{(row) => (
				<SessionPickerRow
					row={row}
					size="compact"
					nowMs={T0}
					onChoose={() => chooseToast(row)}
					onAddProject={() => pushToast("Add project")}
				/>
			)}
		</For>
	</div>
);

export default [
	defineStory({
		id: "sessions-session-picker",
		title: "SessionPicker",
		component: { file: "apps/web/components/sessions/SessionPicker.tsx", export: "SessionPicker" },
		tabs: true,
		seed: { currentWorkspaceId: "sess_09a41c" },
		variants: [
			{
				name: "Resume session",
				description:
					"The /resume dialog: no footer (the close button and Esc dismiss it), the import link beside the search box, the attached session shown but not choosable.",
				seed: () => {
					answerCalls({ resumeList: () => resumeListReply });
					setState("sessionFile", ATTACHED_FILE);
					void searchResume("");
				},
				render: (ctx) => <SessionPicker onClose={ctx.close} />,
			},
			{
				name: "Before the list arrives",
				description:
					"The session process has not answered yet; the list shows its loading state until it does.",
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
				name: "Grouped with expansion",
				description:
					"Pinned, today, and earlier groups. A click or the arrow keys select a row, which expands in place with its latest conversation and actions: Rename and Delete… on the left, Resume on the right. Enter resumes the selected row.",
				render: () => (
					<div class="ds-frame ds-frame-panel">
						<SessionListStory rows={listRows()} canManage scope currentCwd={PROJECT_CWD} />
					</div>
				),
			},
			{
				name: "Read only",
				description:
					"The session process does not advertise rename and delete, so those actions are hidden.",
				render: () => (
					<div class="ds-frame ds-frame-panel">
						<SessionListStory rows={listRows()} canManage={false} scope currentCwd={PROJECT_CWD} />
					</div>
				),
			},
			{
				name: "Mixed row states",
				description:
					"Pinned, empty, attached, errored, interrupted, blocked and long-title rows in one list. Other projects show their folder in the expansion.",
				render: () => (
					<div class="ds-frame ds-frame-panel">
						<SessionListStory
							rows={[NORMAL, PINNED, EMPTY, CURRENT, ERRORED, INTERRUPTED, BLOCKED, LONG]}
							canManage
							scope
							currentCwd={PROJECT_CWD}
						/>
					</div>
				),
			},
			{
				name: "Truncated list",
				description:
					"The session process matched more sessions than it sent: the count line says so.",
				render: () => (
					<div class="ds-frame ds-frame-panel">
						<SessionListStory rows={listRows()} total={240} canManage currentCwd={PROJECT_CWD} />
					</div>
				),
			},
			{
				name: "Worktree mode",
				description:
					"Resume only (no manage actions, no scope switch); a caller note replaces the count line.",
				render: () => (
					<div class="ds-frame ds-frame-panel">
						<SessionListStory
							rows={[NORMAL, ERRORED, INTERRUPTED, LONG].map((row) => ({
								...row,
								cwd: PROJECT_CWD,
							}))}
							actions="resume"
							note="Showing the latest 200"
							currentCwd={PROJECT_CWD}
						/>
					</div>
				),
			},
			{
				name: "No matches",
				render: () => (
					<div class="ds-frame ds-frame-panel">
						<SessionListStory rows={[]} canManage emptyText="No sessions match this search." />
					</div>
				),
			},
			{
				name: "Loading",
				render: () => (
					<div class="ds-frame ds-frame-panel">
						<SessionListStory rows={[]} loading canManage />
					</div>
				),
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
				name: "Full: normal",
				description:
					"One left-aligned line: title, age at the right edge. No dot for a complete session.",
				render: () => <FullRow row={NORMAL} />,
			},
			{
				name: "Full: pinned",
				render: () => <FullRow row={PINNED} />,
			},
			{
				name: "Full: empty",
				description: "A session with no messages carries the `empty` tag.",
				render: () => <FullRow row={EMPTY} />,
			},
			{
				name: "Full: current",
				description: "The attached session is accent-coloured, labelled, and not a resume target.",
				render: () => <FullRow row={CURRENT} />,
			},
			{
				name: "Full: error status",
				description:
					"Abnormal outcomes (error, interrupted, aborted, in progress) get a status dot.",
				render: () => (
					<div class="ds-frame ds-frame-panel">
						<SessionPickerRow
							row={ERRORED}
							size="full"
							nowMs={T0}
							onChoose={() => chooseToast(ERRORED)}
						/>
						<SessionPickerRow
							row={INTERRUPTED}
							size="full"
							nowMs={T0}
							onChoose={() => chooseToast(INTERRUPTED)}
						/>
					</div>
				),
			},
			{
				name: "Full: blocked",
				description:
					"Disabled with the reason; Add project opens the dialog prefilled with the folder.",
				render: () => <FullRow row={BLOCKED} showProject />,
			},
			{
				name: "Full: all projects",
				description: "The project label follows the title; a long title truncates.",
				render: () => <FullRow row={LONG} showProject active />,
			},
			{
				name: "Compact: sidebar width",
				description:
					"The tighter density in a 250px sidebar column, with a long title and a blocked row.",
				render: () => (
					<CompactRows
						frame="ds-frame-sidebar"
						rows={[NORMAL, PINNED, ERRORED, CURRENT, LONG, BLOCKED]}
					/>
				),
			},
			{
				name: "Compact: phone width",
				render: () => (
					<CompactRows
						frame="ds-frame ds-frame-narrow"
						rows={[NORMAL, PINNED, ERRORED, CURRENT, LONG, BLOCKED]}
					/>
				),
			},
		],
	}),
];
