import { createMemo, createSignal, For, Show, type Component, type JSX } from "solid-js";
import {
	formatSessionAge,
	groupSessions,
	normalizeSessionTitle,
	sessionDisplayTitle,
	sessionStatusLabel,
	sessionSubtitle,
	type SessionRow,
} from "../../store/session-list";
import { SessionPickerRow } from "./SessionPickerRow";

/**
 * Reusable session list: grouped Pinned / Today / Earlier rows, status dots,
 * first-prompt subtitles, a preview pane, arrow-key navigation, inline rename and
 * a delete confirm strip. It owns only per-list UI state (active row, rename and
 * delete mode). Data and every mutation come in through props, so Analysis can
 * reuse it with its own data source and actions.
 */
export interface SessionListPickerProps {
	rows: readonly SessionRow[];
	/** Daemon-wide match count; shown as "N of M" when the list is truncated. */
	total: number;
	query: string;
	onQuery: (query: string) => void;
	loading?: boolean;
	/** Omit to hide the "All projects" toggle. */
	allProjects?: boolean;
	onAllProjects?: (on: boolean) => void;
	/** Rename and delete are offered only when the daemon advertises them. */
	canManage: boolean;
	/** Clock for ages; defaults to Date.now. */
	now?: () => number;
	emptyText?: string;
	onChoose: (row: SessionRow) => void;
	/** Offers Add project on rows no registered project owns (their reason is shown). */
	onAddProject?: (row: SessionRow) => void;
	onTogglePin: (row: SessionRow) => void;
	onRename: (row: SessionRow, title: string) => Promise<boolean>;
	onDelete: (row: SessionRow) => Promise<boolean>;
	children?: JSX.Element;
}

export const SessionListPicker: Component<SessionListPickerProps> = (props) => {
	const now = () => (props.now ?? Date.now)();
	const grouped = createMemo(() => groupSessions(props.rows, now()));
	const flat = createMemo(() => grouped().groups.flatMap((group) => group.rows));
	const [activeFile, setActiveFile] = createSignal<string | null>(null);
	const active = createMemo(() => flat().find((row) => row.file === activeFile()) ?? flat()[0]);

	const [renameFile, setRenameFile] = createSignal<string | null>(null);
	const [renameText, setRenameText] = createSignal("");
	const [renameError, setRenameError] = createSignal<string | null>(null);
	const [deleteFile, setDeleteFile] = createSignal<string | null>(null);
	const [busy, setBusy] = createSignal(false);

	/** Moving to another row drops any pending rename or delete on the previous one. */
	const activate = (row: SessionRow) => {
		if (row.file === active()?.file) return;
		setActiveFile(row.file);
		setRenameFile(null);
		setDeleteFile(null);
	};

	const step = (delta: number) => {
		const list = flat();
		if (list.length === 0) return;
		const index = Math.max(
			0,
			list.findIndex((row) => row === active()),
		);
		const next = list[Math.min(list.length - 1, Math.max(0, index + delta))];
		if (next) activate(next);
	};

	const startRename = (row: SessionRow) => {
		setDeleteFile(null);
		setRenameError(null);
		setRenameText(row.title ?? "");
		setRenameFile(row.file);
	};

	const submitRename = async (row: SessionRow) => {
		const title = normalizeSessionTitle(renameText());
		if (!title) {
			setRenameError("Enter a title of 1 to 200 characters.");
			return;
		}
		setBusy(true);
		try {
			if (await props.onRename(row, title)) setRenameFile(null);
		} finally {
			setBusy(false);
		}
	};

	const confirmDelete = async (row: SessionRow) => {
		setBusy(true);
		try {
			if (await props.onDelete(row)) setDeleteFile(null);
		} finally {
			setBusy(false);
		}
	};

	const onSearchKey = (event: KeyboardEvent) => {
		const current = active();
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			step(event.key === "ArrowDown" ? 1 : -1);
		} else if (event.key === "Enter" && current && !current.current) {
			event.preventDefault();
			props.onChoose(current);
		}
	};

	const onRenameKey = (event: KeyboardEvent, row: SessionRow) => {
		if (event.key === "Enter") {
			event.preventDefault();
			void submitRename(row);
		} else if (event.key === "Escape") {
			event.stopPropagation();
			setRenameFile(null);
		}
	};

	const onDeleteKey = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			event.stopPropagation();
			setDeleteFile(null);
		}
	};

	return (
		<div class="session-list-picker">
			<div class="session-list-toolbar">
				<input
					type="search"
					class="session-list-search"
					aria-label="Search sessions"
					placeholder="Search title, prompt, directory, or id…"
					value={props.query}
					onInput={(event) => props.onQuery(event.currentTarget.value)}
					onKeyDown={onSearchKey}
				/>
				<Show when={props.onAllProjects !== undefined}>
					<label class="session-list-scope">
						<input
							type="checkbox"
							checked={props.allProjects === true}
							onChange={(event) => props.onAllProjects?.(event.currentTarget.checked)}
						/>
						All projects
					</label>
				</Show>
			</div>
			{props.children}
			<div class="session-list-count" aria-live="polite">
				{flat().length} {flat().length === 1 ? "session" : "sessions"}
				{props.total > flat().length ? ` of ${props.total}` : ""}
			</div>
			<div class="session-list-body">
				<div class="session-list-rows">
					<Show
						when={!props.loading}
						fallback={<div class="tool-collapsed-note">loading sessions…</div>}
					>
						<Show
							when={flat().length > 0}
							fallback={
								<div class="tool-collapsed-note">
									{props.emptyText ??
										(props.query ? "No sessions match this search." : "No sessions yet.")}
								</div>
							}
						>
							<For each={grouped().groups}>
								{(group) => (
									<div class="session-group" data-group={group.key}>
										<div class="session-group-title">
											{group.label} · {group.rows.length}
										</div>
										<For each={group.rows}>
											{(row) => (
												<SessionPickerRow
													row={row}
													active={active() === row}
													showProject={props.allProjects === true}
													nowMs={now()}
													onActivate={() => activate(row)}
													onChoose={() => props.onChoose(row)}
													onAddProject={
														props.onAddProject ? () => props.onAddProject?.(row) : undefined
													}
													onTogglePin={() => props.onTogglePin(row)}
												/>
											)}
										</For>
									</div>
								)}
							</For>
						</Show>
					</Show>
				</div>
				<Show when={active()}>
					{(row) => (
						<aside class="session-preview" aria-label="Session preview">
							<Show
								when={renameFile() === row().file}
								fallback={<h3 class="session-preview-title">{sessionDisplayTitle(row())}</h3>}
							>
								<div class="session-rename" data-inline-escape>
									<input
										type="text"
										class="session-rename-input"
										aria-label="New session title"
										maxLength={200}
										value={renameText()}
										onInput={(event) => setRenameText(event.currentTarget.value)}
										onKeyDown={(event) => onRenameKey(event, row())}
									/>
									<Show when={renameError()}>
										{(message) => <div class="msg-notice">{message()}</div>}
									</Show>
									<div class="session-preview-actions">
										<button
											type="button"
											disabled={busy()}
											onClick={() => void submitRename(row())}
										>
											Save title
										</button>
										<button type="button" onClick={() => setRenameFile(null)}>
											Cancel
										</button>
									</div>
								</div>
							</Show>
							<Show when={sessionSubtitle(row())}>
								{(subtitle) => <p class="session-preview-prompt">{subtitle()}</p>}
							</Show>
							<dl class="session-preview-meta">
								<dt>Status</dt>
								<dd>{sessionStatusLabel(row().status)}</dd>
								<dt>Messages</dt>
								<dd>{row().messageCount}</dd>
								<dt>Modified</dt>
								<dd>{formatSessionAge(row().modifiedMs, now())}</dd>
								<dt>Directory</dt>
								<dd>{row().cwd || "(no directory)"}</dd>
								<dt>Session id</dt>
								<dd>{row().id}</dd>
							</dl>
							<Show when={row().firstMessage}>
								{(text) => (
									<section class="session-preview-section">
										<h4>First prompt</h4>
										<p class="session-preview-text">{text()}</p>
									</section>
								)}
							</Show>
							<Show when={row().recentText}>
								{(text) => (
									<section class="session-preview-section">
										<h4>Latest conversation</h4>
										<p class="session-preview-text">{text()}</p>
									</section>
								)}
							</Show>
							<div class="session-preview-actions">
								<button
									type="button"
									class="session-resume"
									disabled={row().current === true || row().blocked !== undefined}
									title={
										row().current ? "This session is already attached." : row().blocked?.reason
									}
									onClick={() => props.onChoose(row())}
								>
									{row().current ? "Current session" : "Resume"}
								</button>
								<Show when={props.canManage && renameFile() !== row().file}>
									<button type="button" onClick={() => startRename(row())}>
										Rename
									</button>
									<button
										type="button"
										class="danger"
										disabled={row().current === true}
										title={
											row().current ? "Use /delete to delete the attached session." : undefined
										}
										onClick={() => {
											setRenameFile(null);
											setDeleteFile(row().file);
										}}
									>
										Delete…
									</button>
								</Show>
							</div>
							<Show when={deleteFile() === row().file}>
								<div
									class="session-delete-confirm"
									role="alertdialog"
									data-inline-escape
									onKeyDown={onDeleteKey}
								>
									<p>
										Delete this session? Its transcript file and artifacts are removed from disk.
										This cannot be undone.
									</p>
									<div class="session-preview-actions">
										<button
											type="button"
											class="danger"
											disabled={busy()}
											onClick={() => void confirmDelete(row())}
										>
											Delete session
										</button>
										<button type="button" onClick={() => setDeleteFile(null)}>
											Cancel
										</button>
									</div>
								</div>
							</Show>
						</aside>
					)}
				</Show>
			</div>
		</div>
	);
};
