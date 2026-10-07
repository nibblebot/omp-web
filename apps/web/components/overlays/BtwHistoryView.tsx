import { For, Match, Show, Switch, createEffect, onMount, type Component } from "solid-js";
import {
	btwDraft,
	btwDrafts,
	btwHistoryAvailable,
	btwHistoryError,
	btwHistoryLoading,
	btwHistoryNotice,
	btwHistoryRecords,
	btwHistoryTotal,
	btwPreview,
	btwPreviewLoading,
	btwPromoteResult,
	btwPromoting,
	btwSearchQuery,
	btwSelectedId,
	btwStreaming,
	btwTranscript,
	closeBtwHistory,
	confirmPromoteBtw,
	copyBtw,
	dismissBtwHistoryStatus,
	followUpBtw,
	pageBtwTranscript,
	previewPromoteBtw,
	rediscoverBtwHistory,
	searchBtwHistory,
	selectBtwRecord,
	setBtwDraft,
	stopBtwTurn,
} from "../../store/btw-history";
import { state } from "../../state";
import { Markdown } from "../shared/Markdown";
import { Modal } from "../shared/Modal";

/**
 * G09 durable BTW history view: history list + search + paged transcript +
 * follow-up box + copy + close-vs-stop + promote preview/confirm. Solid thin
 * component: transient presentation only (the durable mirror lives in
 * store/btw-history.ts; server owns durable state). No state.ts edits, no
 * index.ts registration — the integrator mounts this where the ephemeral
 * BtwPanel is offered.
 *
 * Copy uses navigator.clipboard with a textarea fallback
 * (web/text/clipboard); a refusal surfaces a notice, never a throw.
 */

function statusLabel(status: string): string {
	switch (status) {
		case "complete":
			return "done";
		case "running":
			return "answering…";
		case "cancelled":
			return "cancelled";
		case "error":
			return "error";
		case "interrupted":
			return "interrupted";
		default:
			return status;
	}
}

function formatTime(epochMs: number): string {
	if (!epochMs) return "";
	try {
		return new Date(epochMs).toLocaleString();
	} catch {
		return "";
	}
}

const BtwRecordRow: Component<{ id: string; question: string; answer: string; status: string }> = (
	props,
) => (
	<button
		type="button"
		class="btw-history-row"
		classList={{ selected: btwSelectedId() === props.id }}
		onClick={() => selectBtwRecord(props.id)}
	>
		<span class="btw-history-row-question">{props.question || "(empty question)"}</span>
		<span class="btw-history-row-meta">
			{statusLabel(props.status)}
			<Show when={btwStreaming()[props.id]}> · answering…</Show>
		</span>
	</button>
);

export const BtwHistoryView: Component<{ onClose: () => void }> = (props) => {
	let searchInput!: HTMLInputElement;
	let followUpBox!: HTMLTextAreaElement;
	let searchDebounce = 0;

	const handleClose = (): void => {
		closeBtwHistory();
		props.onClose();
	};

	const queueSearch = (value: string): void => {
		if (searchDebounce !== 0) window.clearTimeout(searchDebounce);
		searchDebounce = window.setTimeout(() => {
			searchDebounce = 0;
			searchBtwHistory(value);
		}, 250);
	};

	onMount(() => {
		// New connections rediscover saved side sessions (re-list on open too;
		// Main leaf is never touched client-side).
		rediscoverBtwHistory();
		searchInput?.focus();
	});

	createEffect(() => {
		// Keep the transcript's record in step when the mirror refreshes
		// (polling turns, follow-up settle) without moving selection.
		btwHistoryRecords();
	});

	const selected = () => btwHistoryRecords().find((record) => record.id === btwSelectedId());
	const draftValue = () => (btwSelectedId() === null ? "" : (btwDraft(btwSelectedId()!) ?? ""));

	// Subscribe so the composer re-renders as drafts change elsewhere.
	const draftTick = () => {
		btwDrafts();
		return draftValue();
	};

	const canFollowUp = (): boolean => {
		const record = selected();
		if (!record || btwStreaming()[record.id]) return false;
		const latest = record.followUps?.at(-1) ?? record;
		return latest.status !== "running";
	};

	return (
		<Modal title="BTW history" variant="sheet" onClose={handleClose}>
			<div class="btw-history">
				<Show when={btwHistoryAvailable() === false}>
					<div class="msg-notice">
						BTW history is unavailable on this daemon. The ephemeral /btw panel still works; saved
						history needs the matching server methods.
					</div>
				</Show>
				<Show when={btwHistoryError()}>
					{(message) => (
						<div class="msg-notice">
							{message()}
							<button type="button" class="btw-history-dismiss" onClick={dismissBtwHistoryStatus}>
								dismiss
							</button>
						</div>
					)}
				</Show>
				<Show when={btwHistoryNotice()}>
					{(notice) => (
						<div class="msg-notice">
							{notice()}
							<button type="button" class="btw-history-dismiss" onClick={dismissBtwHistoryStatus}>
								dismiss
							</button>
						</div>
					)}
				</Show>

				<div class="btw-history-search">
					<input
						ref={searchInput}
						type="search"
						class="btw-history-search-input"
						placeholder="Search saved side questions…"
						aria-label="Search BTW history"
						value={btwSearchQuery()}
						onInput={(event) => queueSearch(event.currentTarget.value)}
					/>
					<span class="btw-history-count" aria-live="polite">
						<Show when={btwHistoryLoading()} fallback={`${btwHistoryTotal()} saved`}>
							loading…
						</Show>
					</span>
				</div>

				<div class="btw-history-body">
					<div class="btw-history-list" role="listbox" aria-label="Saved side questions">
						<Show
							when={btwHistoryRecords().length > 0}
							fallback={
								<div class="tool-collapsed-note">
									<Show
										when={btwSearchQuery().trim()}
										fallback="No saved side questions yet. Ask with /btw <question>."
									>
										No matches. Ordinary search never moves the Main leaf.
									</Show>
								</div>
							}
						>
							<For each={btwHistoryRecords()}>
								{(record) => (
									<BtwRecordRow
										id={record.id}
										question={record.question}
										answer={record.answer}
										status={(record.followUps?.at(-1) ?? record).status}
									/>
								)}
							</For>
						</Show>
					</div>

					<div class="btw-history-detail">
						<Show
							when={selected()}
							fallback={<div class="tool-collapsed-note">Select a side question to read it.</div>}
						>
							{(record) => (
								<div class="btw-history-turns">
									<div class="btw-question">{record().question}</div>
									<Show when={formatTime(record().createdAt)}>
										{(when) => <div class="btw-history-time">{when()}</div>}
									</Show>
									<For each={btwTranscript().turns}>
										{(turn) => (
											<div class="btw-history-turn">
												<Show when={turn.index > 0}>
													<div class="btw-history-followup-q">{turn.question}</div>
												</Show>
												<div class="btw-reply">
													<Markdown src={turn.answer} />
													<Show when={turn.status === "running"}>
														<span class="btw-cursor" aria-hidden="true" />
													</Show>
												</div>
												<div class="btw-history-turn-meta">
													{statusLabel(turn.status)}
													<Show when={turn.error}> · {turn.error}</Show>
												</div>
											</div>
										)}
									</For>
									<Show when={btwTranscript().loading}>
										<div class="tool-collapsed-note">loading transcript…</div>
									</Show>
									<Show when={btwTranscript().nextAfter !== undefined}>
										<button
											type="button"
											class="btw-history-more"
											disabled={btwTranscript().loading}
											onClick={pageBtwTranscript}
										>
											show more ({btwTranscript().total - btwTranscript().turns.length} left)
										</button>
									</Show>

									<div class="btw-history-followup">
										<textarea
											ref={followUpBox}
											class="btw-history-followup-box"
											rows={2}
											placeholder="Follow up on this side thread… (never enters the transcript)"
											aria-label="Follow-up question"
											value={draftTick()}
											onInput={(event) => setBtwDraft(record().id, event.currentTarget.value)}
											onKeyDown={(event) => {
												if (event.key === "Enter" && !event.shiftKey) {
													event.preventDefault();
													followUpBtw(record().id);
												}
											}}
										/>
										<div class="btw-history-actions">
											<button
												type="button"
												class="btw-history-send"
												disabled={!canFollowUp() || !draftValue().trim()}
												onClick={() => followUpBtw(record().id)}
											>
												<Show when={btwStreaming()[record().id]} fallback="ask follow-up">
													answering…
												</Show>
											</button>
											<button
												type="button"
												class="btw-history-copy"
												onClick={() => copyBtw(record().id)}
											>
												copy
											</button>
											<Show when={btwStreaming()[record().id]}>
												<button
													type="button"
													class="btw-abort"
													onClick={() => stopBtwTurn(record().id)}
												>
													stop
												</button>
											</Show>
											<button
												type="button"
												class="btw-history-promote-preview"
												onClick={() => previewPromoteBtw(record().id)}
											>
												promote…
											</button>
										</div>
									</div>

									<Show when={btwPreviewLoading()}>
										<div class="tool-collapsed-note">checking promotion…</div>
									</Show>
									<Show
										when={(() => {
											const p = btwPreview();
											return p && p.recordId === record().id ? p : undefined;
										})()}
										keyed
									>
										{(preview) => (
											<div class="btw-history-promote">
												<Switch>
													<Match when={preview.eligible}>
														<div class="btw-history-promote-ok">
															Ready to branch this answer into the session tree. Promotion carries
															one Q/A pair ({preview.turns} turn
															{preview.turns === 1 ? "" : "s"}); Main stays where it is until the
															branch lands.
														</div>
														<button
															type="button"
															class="btw-history-promote-confirm"
															disabled={btwPromoting()}
															onClick={() => confirmPromoteBtw(record().id)}
														>
															{btwPromoting() ? "branching…" : "confirm promote"}
														</button>
													</Match>
													<Match when={!preview.eligible}>
														<div class="msg-notice">
															Cannot promote: {preview.reason ?? "not eligible."}
														</div>
													</Match>
												</Switch>
											</div>
										)}
									</Show>
									<Show
										when={(() => {
											const r = btwPromoteResult();
											return r && btwSelectedId() === record().id ? r : undefined;
										})()}
										keyed
									>
										{(result) => (
											<div class="msg-notice">
												<Show
													when={result.cancelled}
													fallback={
														<>
															Branched{result.sessionFile ? ` to ${result.sessionFile}` : ""}. Adopt
															it through the normal session switch flow —
															{state.sessionId ? " Main was untouched until success." : ""}
														</>
													}
												>
													Promotion was cancelled by a session hook; nothing changed.
												</Show>
											</div>
										)}
									</Show>
								</div>
							)}
						</Show>
					</div>
				</div>

				<div class="btw-footer">
					<Show when={btwSelectedId() !== null && btwStreaming()[btwSelectedId()!]}>
						<span class="tool-collapsed-note">
							Closing keeps a running answer alive; reopen to read it. Stopping aborts the work but
							keeps saved turns.
						</span>
					</Show>
					<button type="button" class="btw-close" onClick={handleClose}>
						close
					</button>
				</div>
			</div>
		</Modal>
	);
};
