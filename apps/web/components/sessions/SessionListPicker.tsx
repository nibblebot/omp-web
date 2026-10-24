import {
	createMemo,
	createSignal,
	For,
	Match,
	onMount,
	Show,
	Switch,
	type Component,
	type JSX,
} from "solid-js";
import {
	groupSessions,
	normalizeSessionTitle,
	sessionExpandText,
	type SessionRow,
} from "../../store/session-list";
import { SessionPickerRow } from "./SessionPickerRow";

/**
 * Reusable session list: one column of Pinned / Today / Earlier rows. Clicking a row
 * or moving with the arrow keys selects it, and the selected row expands in place with
 * its latest conversation (or first prompt), its folder when that differs from
 * `currentCwd`, and its actions; Enter or the Resume button resumes it. It owns only
 * per-list UI state (selected row, rename and delete mode). Data and every mutation
 * come in through props, so the worktree dialog reuses it with its own data source.
 */
export interface SessionListPickerProps {
	rows: readonly SessionRow[];
	/** Match count behind `rows`; "N of M" shows only when it exceeds the rows shown. */
	total: number;
	/** Replaces the count line when set (e.g. "Showing the latest 200"). */
	note?: string;
	query: string;
	onQuery: (query: string) => void;
	loading?: boolean;
	/** Segmented "This project | All projects" switch; shown only when `onAllProjects` is given. */
	allProjects?: boolean;
	onAllProjects?: (on: boolean) => void;
	/** The attached session's folder; an expanded row shows its own folder only when it differs. */
	currentCwd?: string;
	/** `"resume"`: the expansion offers Resume only (worktree mode). Default `"full"`. */
	actions?: "full" | "resume";
	/** Rename and delete are offered only when the daemon advertises them. */
	canManage: boolean;
	/** Clock for ages; defaults to Date.now. */
	now?: () => number;
	emptyText?: string;
	/** Resume: Enter or the Resume button on the selected row (a click only selects). */
	onChoose: (row: SessionRow) => void;
	/** Offers Add project on rows no registered project owns (their reason is shown). */
	onAddProject?: (row: SessionRow) => void;
	onRename?: (row: SessionRow, title: string) => Promise<boolean>;
	onDelete?: (row: SessionRow) => Promise<boolean>;
	autoFocus?: boolean;
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

	let searchEl!: HTMLInputElement;
	let rowsEl!: HTMLDivElement;

	onMount(() => {
		if (props.autoFocus) searchEl.focus();
	});

	const resumeOnly = () => props.actions === "resume";
	const pending = () => renameFile() !== null || deleteFile() !== null;
	const countLine = () =>
		props.note ?? (props.total > flat().length ? `${flat().length} of ${props.total}` : undefined);

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
		if (!next) return;
		activate(next);
		// The expansion renders on the next tick; keep the whole selected item in view, and
		// carry focus along when it sat on a row (the search box keeps it otherwise).
		queueMicrotask(() => {
			const item = rowsEl.querySelector<HTMLElement>('[data-active="true"]');
			item?.scrollIntoView({ block: "nearest" });
			if (document.activeElement?.classList.contains("session-pick-main")) {
				item?.querySelector<HTMLButtonElement>(".session-pick-main")?.focus();
			}
		});
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
			if (await props.onRename?.(row, title)) setRenameFile(null);
		} finally {
			setBusy(false);
		}
	};

	const confirmDelete = async (row: SessionRow) => {
		setBusy(true);
		try {
			if (await props.onDelete?.(row)) setDeleteFile(null);
		} finally {
			setBusy(false);
		}
	};

	const cancelPending = () => {
		setRenameFile(null);
		setDeleteFile(null);
		searchEl.focus();
	};

	const onKeyDown = (event: KeyboardEvent) => {
		if (pending()) {
			// The root carries data-inline-escape while a rename or delete is open, so the
			// Modal leaves Esc to us: cancel the strip first, close on the next Esc.
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				cancelPending();
			}
			return;
		}
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			step(event.key === "ArrowDown" ? 1 : -1);
		} else if (
			event.key === "Enter" &&
			(event.target === searchEl ||
				(event.target as HTMLElement).classList.contains("session-pick-main"))
		) {
			// Enter resumes the selected row from the search box or a focused row (a row's own
			// click only selects it).
			event.preventDefault();
			const current = active();
			if (current && !current.current && !current.blocked) props.onChoose(current);
		}
	};

	const focusOnMount = (select: boolean) => (el: HTMLInputElement | HTMLButtonElement) =>
		queueMicrotask(() => {
			el.focus();
			if (select && el instanceof HTMLInputElement) el.select();
		});

	const expansion = (row: SessionRow): JSX.Element => (
		<div class="session-expand">
			<Show when={sessionExpandText(row)}>
				{(text) => <p class="session-expand-text">{text()}</p>}
			</Show>
			<Show when={row.cwd && row.cwd !== props.currentCwd}>
				<p class="session-expand-folder" title={row.cwd}>
					{row.cwd}
				</p>
			</Show>
			<Switch>
				<Match when={deleteFile() === row.file}>
					<div class="session-expand-confirm" role="alertdialog" aria-label="Delete session">
						<p>
							Delete this session? Its transcript file and artifacts are removed from disk. This
							cannot be undone.
						</p>
						<div class="session-expand-actions">
							<button
								type="button"
								class="session-action quiet"
								ref={focusOnMount(false)}
								onClick={cancelPending}
							>
								Cancel
							</button>
							<button
								type="button"
								class="session-action danger"
								disabled={busy()}
								onClick={() => void confirmDelete(row)}
							>
								Delete session
							</button>
						</div>
					</div>
				</Match>
				<Match when={renameFile() === row.file}>
					<div class="session-expand-rename">
						<input
							type="text"
							class="session-expand-rename-input"
							aria-label="New session title"
							maxLength={200}
							value={renameText()}
							ref={focusOnMount(true)}
							onInput={(event) => setRenameText(event.currentTarget.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									void submitRename(row);
								}
							}}
						/>
						<Show when={renameError()}>
							{(message) => <div class="msg-notice">{message()}</div>}
						</Show>
						<div class="session-expand-actions">
							<button type="button" class="session-action quiet" onClick={cancelPending}>
								Cancel
							</button>
							<button
								type="button"
								class="session-action primary"
								disabled={busy()}
								onClick={() => void submitRename(row)}
							>
								Save title
							</button>
						</div>
					</div>
				</Match>
				<Match when={true}>
					<div class="session-expand-actions">
						<Show when={!resumeOnly() && props.canManage}>
							<Show when={props.onRename !== undefined}>
								<button type="button" class="session-action quiet" onClick={() => startRename(row)}>
									Rename
								</button>
							</Show>
							<Show when={props.onDelete !== undefined && !row.current}>
								<button
									type="button"
									class="session-action quiet danger"
									onClick={() => {
										setRenameFile(null);
										setDeleteFile(row.file);
									}}
								>
									Delete…
								</button>
							</Show>
						</Show>
						<Show when={!row.current} fallback={<span class="session-expand-note">Open now</span>}>
							<button
								type="button"
								class="session-action primary"
								disabled={row.blocked !== undefined}
								title={row.blocked?.reason}
								onClick={() => props.onChoose(row)}
							>
								Resume
							</button>
						</Show>
					</div>
				</Match>
			</Switch>
		</div>
	);

	return (
		<div
			class="session-list-picker"
			data-inline-escape={pending() ? "" : undefined}
			onKeyDown={onKeyDown}
		>
			<div class="session-list-toolbar">
				<input
					type="search"
					class="session-list-search"
					aria-label="Search sessions"
					placeholder="Search title, prompt, directory, or id…"
					value={props.query}
					ref={searchEl}
					onInput={(event) => props.onQuery(event.currentTarget.value)}
				/>
				<Show when={props.onAllProjects}>
					{(onAllProjects) => (
						<div class="session-scope" role="radiogroup" aria-label="Session scope">
							<button
								type="button"
								role="radio"
								class="session-scope-btn"
								classList={{ selected: props.allProjects !== true }}
								aria-checked={props.allProjects !== true}
								onClick={() => onAllProjects()(false)}
							>
								This project
							</button>
							<button
								type="button"
								role="radio"
								class="session-scope-btn"
								classList={{ selected: props.allProjects === true }}
								aria-checked={props.allProjects === true}
								onClick={() => onAllProjects()(true)}
							>
								All projects
							</button>
						</div>
					)}
				</Show>
			</div>
			<Show when={countLine()}>
				{(text) => (
					<div class="session-list-count" aria-live="polite">
						{text()}
					</div>
				)}
			</Show>
			<div class="session-list-rows" ref={rowsEl}>
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
								<div class="session-list-group" data-group={group.key}>
									<Show when={grouped().groups.length > 1}>
										<div class="session-list-group-title">{group.label}</div>
									</Show>
									<For each={group.rows}>
										{(row) => (
											<div
												class="session-list-item"
												data-active={active()?.file === row.file ? "true" : "false"}
											>
												<SessionPickerRow
													row={row}
													size="full"
													active={active()?.file === row.file}
													showProject={props.allProjects === true}
													nowMs={now()}
													selects
													onChoose={() => activate(row)}
													onAddProject={
														props.onAddProject ? () => props.onAddProject?.(row) : undefined
													}
												/>
												<Show when={active()?.file === row.file}>{expansion(row)}</Show>
											</div>
										)}
									</For>
								</div>
							)}
						</For>
					</Show>
				</Show>
			</div>
			<div class="session-list-keys" aria-hidden="true">
				<span>
					<kbd>↑</kbd>
					<kbd>↓</kbd> select
				</span>
				<span>
					<kbd>Enter</kbd> resume
				</span>
				<span>
					<kbd>Esc</kbd> close
				</span>
			</div>
		</div>
	);
};
