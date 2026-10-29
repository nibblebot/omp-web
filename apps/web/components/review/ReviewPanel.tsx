import {
	createEffect,
	createMemo,
	createSignal,
	For,
	on,
	onCleanup,
	Show,
	type Component,
} from "solid-js";
import type { GitPathEntry } from "#lib/wire/protocol";
import type { GitReviewDiff } from "../../store/slices/review";
import { sha256Hex } from "../../text/sha256";
import { virtualWindow } from "../../usage/model-query";
import {
	createAnnotation,
	fileDiff,
	gitError,
	gitLoading,
	gitSelection,
	gitStatus,
	guardDraftEscape,
	insertIntoComposer,
	isStaleError,
	loadFileDiff,
	refreshGit,
	requestCommit,
	requestStageAll,
	selectedHunks,
	stageHunks,
	stagePaths,
	toggleGitPath,
	toggleHunk,
	unstagePaths,
} from "../../store/review";
import { gitReviewAvailable, gitReviewUnavailableReason } from "../../store/git-capability";

/** Hunks can be staged and annotated only for an unstaged, textual, complete diff. */
const hunksStageable = (diff: GitReviewDiff): boolean =>
	diff.area === "unstaged" && !diff.binary && !diff.tooLarge;

const canStage = (): boolean => gitStatus()?.eligible.stage === true;

/** Whether any of `rows` is selected; the common empty selection costs nothing. */
const anySelected = (rows: GitPathEntry[]): boolean => {
	const picked = gitSelection();
	return picked.size > 0 && rows.some((row) => picked.has(row.path));
};

/** Row pitch (height plus gap) and viewport height used until the first rows mount and get measured. */
const ROW_PITCH_ESTIMATE = 32;
const VIEWPORT_ESTIMATE = 400;

/**
 * One changed-file list. Rows are one line at a fixed pitch and only those near the
 * list's viewport are mounted (spacer padding stands in for the rest), so thousands
 * of paths stay cheap to mount and scroll. Selection is a Set, so a row's checkbox
 * is an O(1) lookup. Tab walks the mounted rows; the overscan keeps the next stop
 * mounted, and the browser scrolling a focused row into view moves the window on.
 */
const PathList: Component<{ area: "unstaged" | "staged"; rows: GitPathEntry[] }> = (props) => {
	const [scrollTop, setScrollTop] = createSignal(0);
	const [viewportHeight, setViewportHeight] = createSignal(VIEWPORT_ESTIMATE);
	const [rowPitch, setRowPitch] = createSignal(ROW_PITCH_ESTIMATE);
	let listEl: HTMLDivElement | undefined;
	const span = createMemo(() =>
		virtualWindow(scrollTop(), viewportHeight(), rowPitch(), props.rows.length),
	);
	const visible = createMemo(() => props.rows.slice(span().start, span().end));
	// The pitch is measured once per size (fractional geometry, as ModelSearchList does), never
	// per window move: re-deriving it on each move can alternate between two values forever.
	let pitchMeasured = false;
	const measure = (): void => {
		if (!listEl) return;
		setViewportHeight(listEl.clientHeight);
		if (pitchMeasured) return;
		const mounted = listEl.querySelectorAll<HTMLElement>(".review-path-row");
		if (mounted.length < 2) return;
		const pitch = mounted[1].getBoundingClientRect().top - mounted[0].getBoundingClientRect().top;
		if (pitch <= 0) return;
		pitchMeasured = true;
		setRowPitch(pitch);
	};
	const resizes = new ResizeObserver(() => {
		pitchMeasured = false;
		measure();
	});
	onCleanup(() => resizes.disconnect());
	return (
		<section class="review-paths">
			<h3>
				{props.area === "unstaged" ? "Worktree" : "Staged"} ({props.rows.length})
			</h3>
			<Show when={props.rows.length > 0} fallback={<p>No changes</p>}>
				<div
					class="review-path-list"
					ref={(el) => {
						listEl = el;
						// A list that emptied and refilled is a new element, scrolled to the top.
						setScrollTop(el.scrollTop);
						resizes.observe(el);
					}}
					onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
				>
					<div
						class="review-path-window"
						style={{
							"padding-top": `${span().start * rowPitch()}px`,
							"padding-bottom": `${(props.rows.length - span().end) * rowPitch()}px`,
						}}
					>
						<For each={visible()}>
							{(row) => {
								const label = (): string =>
									row.origPath ? `${row.origPath} → ${row.path}` : row.path;
								return (
									<div class="review-path-row">
										<label>
											<input
												type="checkbox"
												checked={gitSelection().has(row.path)}
												disabled={gitLoading()}
												onChange={() => toggleGitPath(row.path)}
											/>
											<span title={label()}>{label()}</span>
										</label>
										<div class="review-path-actions">
											<span class="review-badge">{row.kind}</span>
											<Show when={row.kind === "conflicted"}>
												<span class="review-path-hint">Resolve conflict before staging/commit</span>
											</Show>
											<button type="button" onClick={() => void loadFileDiff(row.path, props.area)}>
												View diff
											</button>
											<Show
												when={props.area === "unstaged"}
												fallback={
													<button
														type="button"
														disabled={gitLoading()}
														onClick={() => void unstagePaths([row.path])}
													>
														Unstage
													</button>
												}
											>
												<button
													type="button"
													disabled={gitLoading() || !canStage() || row.kind === "conflicted"}
													onClick={() => void stagePaths([row.path])}
												>
													Stage
												</button>
											</Show>
										</div>
									</div>
								);
							}}
						</For>
					</div>
				</div>
			</Show>
		</section>
	);
};

/**
 * Git review as a dock body (U18). Left: worktree and staged files with
 * per-file stage/unstage. Right: the selected file's hunks, each with stage,
 * "ask the agent", and note actions. Bottom: the commit box.
 */
export const ReviewPanel: Component = () => {
	const [all, setAll] = createSignal(false);
	const [message, setMessage] = createSignal("");
	const [noteIndex, setNoteIndex] = createSignal<number | null>(null);
	const [noteDraft, setNoteDraft] = createSignal("");
	// Refresh when the git capability is (or becomes) available: the panel can mount
	// before the attached session's capabilities land, and a mount-only check then
	// leaves the panel empty until a manual refresh. The memo dedupes by value: state
	// frames replace the capabilities object, which would re-fire a bare effect and
	// loop gitStatus calls forever.
	const gitAvailable = createMemo(() => gitReviewAvailable());
	createEffect(
		on(gitAvailable, (available) => {
			if (available) void refreshGit();
		}),
	);
	const selected = (rows: GitPathEntry[]) => {
		const picked = gitSelection();
		return rows.filter((row) => picked.has(row.path)).map((row) => row.path);
	};
	// The anchor is the hunk's own text, so a later re-diff that changes it is caught as stale.
	const saveNote = async (hunkText: string) => {
		const note = noteDraft().trim();
		if (!note) return;
		await createAnnotation({
			source: "diff",
			anchor: { kind: "text", text: hunkText, contentHash: sha256Hex(hunkText) },
			note,
		});
		setNoteIndex(null);
		setNoteDraft("");
	};
	return (
		<section class="review-panel" aria-label="Git review">
			<Show when={gitReviewAvailable()} fallback={<p>{gitReviewUnavailableReason()}</p>}>
				<div class="review-actions">
					<button type="button" disabled={gitLoading()} onClick={() => void refreshGit()}>
						Refresh repository
					</button>
					<span>{gitLoading() ? "Loading…" : (gitStatus()?.branch ?? "Detached HEAD")}</span>
				</div>
				<Show when={gitError()}>
					{(e) => (
						<div class="review-error" role="alert">
							{e()}
							<Show when={isStaleError(e())}>
								<p>
									For stale fingerprints, refresh the repository and review the new changes before
									retrying.
								</p>
							</Show>
						</div>
					)}
				</Show>
				<Show when={gitStatus()}>
					{(status) => (
						<Show
							when={status().available}
							fallback={<p>{status().reason ?? "Repository unavailable"}</p>}
						>
							<p>{status().cwd}</p>
							<div class="review-split">
								<div class="review-files">
									<PathList area="unstaged" rows={status().unstaged} />
									<div class="review-actions">
										<label>
											<input
												type="checkbox"
												checked={all()}
												onChange={(e) => setAll(e.currentTarget.checked)}
											/>
											Explicitly stage all (confirmation required)
										</label>
										<button
											type="button"
											disabled={
												gitLoading() ||
												!canStage() ||
												(all() ? !status().unstaged.length : !anySelected(status().unstaged))
											}
											onClick={() =>
												all() ? requestStageAll() : void stagePaths(selected(status().unstaged))
											}
										>
											Stage {all() ? "all" : "selected paths"}
										</button>
									</div>
									<PathList area="staged" rows={status().staged} />
									<button
										type="button"
										disabled={gitLoading() || !anySelected(status().staged)}
										onClick={() => void unstagePaths(selected(status().staged))}
									>
										Unstage selected paths
									</button>
								</div>
								<Show when={fileDiff()}>
									{(diff) => (
										<section class="review-diff">
											<h3>
												{diff().path} · {diff().area}
											</h3>
											<Show when={diff().binary}>
												<p>
													Binary file: textual hunks are unavailable. Stage the path explicitly
													instead.
												</p>
											</Show>
											<Show when={diff().tooLarge || diff().truncated}>
												<p>
													Diff exceeds the display limit; omitted content cannot be hunk-staged
													here. Review externally or stage the path explicitly.
												</p>
											</Show>
											<For each={diff().hunks}>
												{(hunk) => (
													<div class="review-hunk">
														<label>
															<input
																type="checkbox"
																checked={selectedHunks().includes(hunk.index)}
																disabled={!hunksStageable(diff()) || gitLoading()}
																onChange={() => toggleHunk(hunk.index)}
															/>
															{hunk.header}
														</label>
														<pre>{hunk.text}</pre>
														<div class="review-actions">
															<Show when={hunksStageable(diff())}>
																<button
																	type="button"
																	disabled={gitLoading() || !canStage()}
																	onClick={() => void stageHunks(diff().path, [hunk.index])}
																>
																	Stage hunk
																</button>
															</Show>
															<button
																type="button"
																onClick={() =>
																	insertIntoComposer(
																		`Question about ${diff().path} (${hunk.header}):\n\`\`\`diff\n${hunk.text}\n\`\`\`\n`,
																	)
																}
															>
																Ask agent about this hunk
															</button>
															<button type="button" onClick={() => setNoteIndex(hunk.index)}>
																Note
															</button>
														</div>
														<Show when={noteIndex() === hunk.index}>
															<div class="review-note">
																<textarea
																	value={noteDraft()}
																	onInput={(e) => setNoteDraft(e.currentTarget.value)}
																	onKeyDown={(e) => guardDraftEscape(e, noteDraft())}
																/>
																<button
																	type="button"
																	disabled={!noteDraft().trim()}
																	onClick={() => void saveNote(hunk.text)}
																>
																	Save note
																</button>
																<button type="button" onClick={() => setNoteIndex(null)}>
																	Cancel
																</button>
															</div>
														</Show>
													</div>
												)}
											</For>
											<Show when={!diff().hunks.length && !diff().binary && !diff().tooLarge}>
												<pre>{diff().patch ?? "No textual changes"}</pre>
											</Show>
											<Show when={hunksStageable(diff())}>
												<button
													type="button"
													disabled={gitLoading() || !canStage() || !selectedHunks().length}
													onClick={() => void stageHunks(diff().path, selectedHunks())}
												>
													Stage selected hunks
												</button>
											</Show>
										</section>
									)}
								</Show>
							</div>
							<Show when={status().eligible.reason}>
								<p>{status().eligible.reason}</p>
							</Show>
							<div class="review-commit">
								<label class="review-field">
									Commit message
									<textarea
										value={message()}
										onInput={(e) => setMessage(e.currentTarget.value)}
										onKeyDown={(e) => guardDraftEscape(e, message())}
									/>
								</label>
								<p>
									Commit includes every currently staged change above; it never stages worktree
									changes.
								</p>
								<button
									type="button"
									disabled={
										gitLoading() ||
										!status().eligible.commit ||
										!status().staged.length ||
										!message().trim()
									}
									onClick={() => requestCommit(message(), () => setMessage(""))}
								>
									Commit staged changes
								</button>
							</div>
						</Show>
					)}
				</Show>
			</Show>
		</section>
	);
};
