import { createSignal, For, onMount, Show, type Component } from "solid-js";
import type { GitPathEntry } from "#lib/wire/protocol";
import {
	gitStatus,
	gitLoading,
	gitError,
	gitSelection,
	selectedHunks,
	fileDiff,
	refreshGit,
	toggleGitPath,
	stagePaths,
	unstagePaths,
	stageHunks,
	commitStaged,
	loadFileDiff,
	toggleHunk,
	reviewAvailable,
	unavailableReason,
} from "../../store/review";

/** Repository mutations always use the store's snapshot fingerprints. */
export const GitPanel: Component = () => {
	const [all, setAll] = createSignal(false);
	const [message, setMessage] = createSignal("");
	const [error, setError] = createSignal("");
	const run = async (action: () => unknown) => {
		setError("");
		try {
			await action();
		} catch (e) {
			setError(String(e));
		}
	};
	onMount(() => {
		if (reviewAvailable("git")) void run(refreshGit);
	});
	const selected = (rows: GitPathEntry[]) =>
		rows.filter((row) => gitSelection().includes(row.path)).map((row) => row.path);
	const stage = () =>
		run(() => {
			if (all()) {
				if (!window.confirm("Stage all worktree changes? This does not commit them.")) return;
				return stagePaths([], true);
			}
			return stagePaths(selected(gitStatus()?.unstaged ?? []));
		});
	const list = (area: "unstaged" | "staged", rows: GitPathEntry[]) => (
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
						<button type="button" onClick={() => void run(() => loadFileDiff(row.path, area))}>
							View diff
						</button>
					</div>
				)}
			</For>
		</section>
	);
	return (
		<section class="review-panel" aria-label="Git review">
			<h2>Git review</h2>
			<Show when={reviewAvailable("git")} fallback={<p>{unavailableReason("git")}</p>}>
				<div class="review-actions">
					<button type="button" disabled={gitLoading()} onClick={() => void run(refreshGit)}>
						Refresh repository
					</button>
					<span>{gitLoading() ? "Loading…" : (gitStatus()?.branch ?? "Detached HEAD")}</span>
				</div>
				<Show when={gitError() || error()}>
					{(e) => (
						<div class="review-error" role="alert">
							{e()}
							<p>
								For stale fingerprints, refresh the repository and review the new changes before
								retrying.
							</p>
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
							{list("unstaged", status().unstaged)}
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
										!status().eligible.stage ||
										(!all() && !selected(status().unstaged).length)
									}
									onClick={() => void stage()}
								>
									Stage {all() ? "all" : "selected paths"}
								</button>
							</div>
							{list("staged", status().staged)}
							<button
								type="button"
								disabled={gitLoading() || !selected(status().staged).length}
								onClick={() => void run(() => unstagePaths(selected(status().staged)))}
							>
								Unstage selected paths
							</button>
							<Show when={status().eligible.reason}>
								<p>{status().eligible.reason}</p>
							</Show>
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
								onClick={() =>
									void run(async () => {
										if (!window.confirm("Commit the staged changes shown above?")) return;
										await commitStaged(message());
										setMessage("");
									})
								}
							>
								Commit staged changes
							</button>
						</Show>
					)}
				</Show>
				<Show when={fileDiff()}>
					{(diff) => (
						<section class="review-diff">
							<h3>
								{diff().path} · {diff().area}
							</h3>
							<Show when={diff().binary}>
								<p>
									Binary file: textual hunks are unavailable. Stage the path explicitly instead.
								</p>
							</Show>
							<Show when={diff().tooLarge || diff().truncated}>
								<p>
									Diff exceeds the display limit; omitted content cannot be hunk-staged here. Review
									externally or stage the path explicitly.
								</p>
							</Show>
							<For each={diff().hunks}>
								{(hunk) => (
									<div>
										<label>
											<input
												type="checkbox"
												checked={selectedHunks().includes(hunk.index)}
												disabled={
													diff().area !== "unstaged" ||
													diff().binary ||
													diff().tooLarge ||
													gitLoading()
												}
												onChange={() => toggleHunk(hunk.index)}
											/>
											{hunk.header}
										</label>
										<pre>{hunk.text}</pre>
									</div>
								)}
							</For>
							<Show when={!diff().hunks.length && !diff().binary && !diff().tooLarge}>
								<pre>{diff().patch ?? "No textual changes"}</pre>
							</Show>
							<button
								type="button"
								disabled={
									gitLoading() ||
									diff().area !== "unstaged" ||
									diff().binary ||
									diff().tooLarge ||
									!selectedHunks().length
								}
								onClick={() => void run(() => stageHunks(diff().path, selectedHunks()))}
							>
								Stage selected hunks
							</button>
						</section>
					)}
				</Show>
			</Show>
		</section>
	);
};
