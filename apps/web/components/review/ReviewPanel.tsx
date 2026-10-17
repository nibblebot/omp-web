import { createEffect, createMemo, createSignal, For, on, Show, type Component } from "solid-js";
import type { GitPathEntry } from "#lib/wire/protocol";
import type { GitReviewDiff } from "../../store/slices/review";
import { sha256Hex } from "../../text/sha256";
import {
	commitStaged,
	createAnnotation,
	fileDiff,
	gitError,
	gitLoading,
	gitSelection,
	gitStatus,
	insertIntoComposer,
	isStaleError,
	loadFileDiff,
	refreshGit,
	requestCommit,
	requestStageAll,
	reviewAvailable,
	selectedHunks,
	stageHunks,
	stagePaths,
	toggleGitPath,
	toggleHunk,
	unavailableReason,
	unstagePaths,
} from "../../store/review";

/** Hunks can be staged and annotated only for an unstaged, textual, complete diff. */
const hunksStageable = (diff: GitReviewDiff): boolean =>
	diff.area === "unstaged" && !diff.binary && !diff.tooLarge;

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
	const gitAvailable = createMemo(() => reviewAvailable("git"));
	createEffect(
		on(gitAvailable, (available) => {
			if (available) void refreshGit();
		}),
	);
	const selected = (rows: GitPathEntry[]) =>
		rows.filter((row) => gitSelection().includes(row.path)).map((row) => row.path);
	const canStage = () => gitStatus()?.eligible.stage === true;
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
	const pathList = (area: "unstaged" | "staged", rows: GitPathEntry[]) => (
		<section class="review-paths">
			<h3>
				{area === "unstaged" ? "Worktree" : "Staged"} ({rows.length})
			</h3>
			<For each={rows} fallback={<p>No changes</p>}>
				{(row) => (
					<div class="review-path-row">
						<label>
							<input
								type="checkbox"
								checked={gitSelection().includes(row.path)}
								disabled={gitLoading()}
								onChange={() => toggleGitPath(row.path)}
							/>
							<span>{row.origPath ? `${row.origPath} → ${row.path}` : row.path}</span>
						</label>
						<span class="review-badge">{row.kind}</span>
						<Show when={row.kind === "conflicted"}>
							<span>Resolve conflict before staging/commit</span>
						</Show>
						<button type="button" onClick={() => void loadFileDiff(row.path, area)}>
							View diff
						</button>
						<Show
							when={area === "unstaged"}
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
				)}
			</For>
		</section>
	);
	return (
		<section class="review-panel" aria-label="Git review">
			<Show when={reviewAvailable("git")} fallback={<p>{unavailableReason("git")}</p>}>
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
									{pathList("unstaged", status().unstaged)}
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
												(all() ? !status().unstaged.length : !selected(status().unstaged).length)
											}
											onClick={() =>
												all() ? requestStageAll() : void stagePaths(selected(status().unstaged))
											}
										>
											Stage {all() ? "all" : "selected paths"}
										</button>
									</div>
									{pathList("staged", status().staged)}
									<button
										type="button"
										disabled={gitLoading() || !selected(status().staged).length}
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
									<textarea value={message()} onInput={(e) => setMessage(e.currentTarget.value)} />
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
