import { For, Show, createSignal, onCleanup, onMount, type Component } from "solid-js";
import { state } from "../../state";
import { askBtw, dismissBtw, followUpBtw } from "../../store/btw";
import { searchAutofocus } from "../../store/integrations";
import {
	btwHistoryError,
	btwHistoryLoading,
	btwHistoryNotice,
	btwHistoryRecords,
	btwHistoryTotal,
	btwPreview,
	btwPreviewLoading,
	btwPromoting,
	btwSearchQuery,
	btwSelectedId,
	btwTranscript,
	closeBtwHistory,
	copyBtw,
	dismissBtwHistoryStatus,
	latestBtwTurn,
	pageBtwTranscript,
	promoteBtw,
	refreshBtwHistory,
	rediscoverBtwHistory,
	searchBtwHistory,
	selectBtwRecord,
	stopBtwTurn,
	type BtwRecordView,
} from "../../store/btw-history";
import { StreamingBlock } from "../chat/transcript/StreamingBlock";
import { Markdown } from "../ui/Markdown";
import { Modal } from "../ui/Modal";

/**
 * The /btw sheet: one place for the side question. The input at the bottom
 * asks a new question (or follows up the selected one); the left column lists
 * saved side questions; the right column shows the live answer, the selected
 * thread's turns, and its actions (copy, stop, promote to transcript).
 *
 * Transient presentation only. The live answer lives in `state.btw`
 * (store/btw.ts); the saved side lives in store/btw-history.ts; the server
 * owns durable state. Closing the sheet never aborts a running question.
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

const BtwTurn: Component<{
	question: string;
	answer: string;
	status: string;
	error?: string;
	streaming?: boolean;
}> = (props) => (
	<article class="btw-turn">
		<div class="btw-question">{props.question || "(empty question)"}</div>
		<div class="btw-meta">{statusLabel(props.status)}</div>
		<Show when={props.answer || props.streaming}>
			<div class="btw-reply">
				<Markdown src={props.answer} />
				<Show when={props.streaming}>
					<span class="btw-cursor" aria-hidden="true" />
				</Show>
			</div>
		</Show>
		<Show when={props.error}>{(err) => <div class="msg-notice">{err()}</div>}</Show>
	</article>
);

export const BtwSheet: Component<{ onClose: () => void }> = (props) => {
	const [draft, setDraft] = createSignal("");
	let input!: HTMLTextAreaElement;
	let searchDebounce = 0;

	onMount(() => {
		rediscoverBtwHistory();
		// A soft keyboard would cover the history list the sheet opens on.
		if (searchAutofocus()) input?.focus();
	});
	onCleanup(() => {
		if (searchDebounce !== 0) window.clearTimeout(searchDebounce);
		closeBtwHistory();
	});

	const selected = (): BtwRecordView | undefined =>
		btwHistoryRecords().find((record) => record.id === btwSelectedId());
	const busy = (): boolean => state.btw?.streaming === true;
	const canFollowUp = (record: BtwRecordView): boolean =>
		latestBtwTurn(record).status !== "running";
	const composeLabel = (): string => {
		const record = selected();
		return record && canFollowUp(record) ? "Follow up" : "Ask";
	};

	const submit = (): void => {
		const text = draft().trim();
		const record = selected();
		if (!text || busy()) return;
		if (record && canFollowUp(record)) followUpBtw(record.id, text);
		else askBtw(text);
		setDraft("");
	};

	const queueSearch = (value: string): void => {
		if (searchDebounce !== 0) window.clearTimeout(searchDebounce);
		searchDebounce = window.setTimeout(() => {
			searchDebounce = 0;
			searchBtwHistory(value);
		}, 250);
	};

	const promote = (id: string): void => {
		// The promoted pair now belongs to the branched session, so the old
		// selection is dropped by the refresh instead of re-fetched.
		void promoteBtw(id).then(() => refreshBtwHistory());
	};

	const promoteBlockedReason = (): string => {
		const preview = btwPreview();
		return preview && !preview.eligible
			? (preview.reason ?? "This side question cannot be promoted.")
			: "";
	};

	return (
		<Modal title="Side questions" variant="sheet" onClose={props.onClose}>
			<div class="btw-sheet">
				<div class="btw-body">
					<aside class="btw-list" aria-label="Saved side questions">
						<div class="btw-list-head">
							<span class="btw-list-count">{btwHistoryTotal()} saved</span>
							<button type="button" class="btw-action" onClick={() => selectBtwRecord(null)}>
								New question
							</button>
						</div>
						<input
							type="search"
							class="btw-search"
							placeholder="Search questions and answers"
							aria-label="Search side questions"
							value={btwSearchQuery()}
							onInput={(event) => queueSearch(event.currentTarget.value)}
						/>
						<Show when={btwHistoryLoading()}>
							<div class="tool-collapsed-note">Loading…</div>
						</Show>
						<For each={btwHistoryRecords()}>
							{(record) => (
								<button
									type="button"
									class="btw-row"
									classList={{ selected: btwSelectedId() === record.id }}
									onClick={() => selectBtwRecord(record.id)}
								>
									<span class="btw-row-question">{record.question || "(empty question)"}</span>
									<span class="btw-row-meta">{statusLabel(latestBtwTurn(record).status)}</span>
								</button>
							)}
						</For>
						<Show when={!btwHistoryLoading() && btwHistoryRecords().length === 0}>
							<div class="tool-collapsed-note">No saved side questions yet.</div>
						</Show>
					</aside>

					<section class="btw-detail" aria-live="polite">
						<Show when={state.btw}>
							{(live) => (
								<article class="btw-turn btw-turn-live">
									<div class="btw-question">{live().question}</div>
									<div class="btw-meta">{live().streaming ? "answering…" : "error"}</div>
									<Show when={live().reply || live().streaming}>
										<div class="btw-reply">
											{/* Frozen blocks render once; only the open block re-renders per flush. */}
											<StreamingBlock
												block={{
													get text() {
														return live().reply;
													},
												}}
											/>
											<Show when={live().streaming}>
												<span class="btw-cursor" aria-hidden="true" />
											</Show>
										</div>
									</Show>
									<Show when={live().error}>{(err) => <div class="msg-notice">{err()}</div>}</Show>
									<div class="btw-actions">
										<Show
											when={live().streaming}
											fallback={
												<button type="button" class="btw-action" onClick={dismissBtw}>
													Dismiss
												</button>
											}
										>
											<button type="button" class="btw-action" onClick={() => stopBtwTurn()}>
												Stop
											</button>
										</Show>
									</div>
								</article>
							)}
						</Show>

						<Show when={selected()}>
							{(record) => (
								<>
									<Show when={btwTranscript().loading}>
										<div class="tool-collapsed-note">Loading the thread…</div>
									</Show>
									<Show when={btwTranscript().recordId === record().id}>
										<For each={btwTranscript().turns}>
											{(turn) => (
												<BtwTurn
													question={turn.question}
													answer={turn.answer}
													status={turn.status}
													error={turn.error}
												/>
											)}
										</For>
										<Show when={btwTranscript().nextAfter !== undefined}>
											<button type="button" class="btw-action" onClick={() => pageBtwTranscript()}>
												Load older turns
											</button>
										</Show>
									</Show>
									<div class="btw-actions">
										<button type="button" class="btw-action" onClick={() => copyBtw(record().id)}>
											Copy answer
										</button>
										<Show when={latestBtwTurn(record()).status === "running"}>
											<button
												type="button"
												class="btw-action"
												onClick={() => stopBtwTurn(record().id)}
											>
												Stop
											</button>
										</Show>
										<button
											type="button"
											class="btw-action btw-promote"
											disabled={
												btwPromoting() || btwPreviewLoading() || btwPreview()?.eligible !== true
											}
											title="Adds this question and its answer to the session transcript."
											onClick={() => promote(record().id)}
										>
											{btwPromoting() ? "Promoting…" : "Promote to transcript"}
										</button>
									</div>
									<Show when={promoteBlockedReason()}>
										{(reason) => <div class="btw-hint">{reason()}</div>}
									</Show>
								</>
							)}
						</Show>

						<Show when={!state.btw && !selected()}>
							<div class="btw-empty">
								Ask a side question below. Answers are saved to this session&apos;s history; promote
								one into the transcript when you want it there.
							</div>
						</Show>

						<Show when={btwHistoryError()}>
							{(err) => (
								<div class="msg-notice btw-status" role="alert">
									{err()}
									<button type="button" class="btw-action" onClick={dismissBtwHistoryStatus}>
										Dismiss
									</button>
								</div>
							)}
						</Show>
						<Show when={btwHistoryNotice()}>
							{(notice) => (
								<div class="btw-hint btw-status">
									{notice()}
									<button type="button" class="btw-action" onClick={dismissBtwHistoryStatus}>
										Dismiss
									</button>
								</div>
							)}
						</Show>
					</section>
				</div>

				<form
					class="btw-compose"
					onSubmit={(event) => {
						event.preventDefault();
						submit();
					}}
				>
					<textarea
						ref={input}
						class="btw-input"
						rows={2}
						aria-label="Side question"
						placeholder={
							selected() ? "Follow up on the selected question…" : "Ask a side question…"
						}
						value={draft()}
						disabled={busy()}
						onInput={(event) => setDraft(event.currentTarget.value)}
						autocomplete="off"
						onKeyDown={(event) => {
							if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) submit();
						}}
					/>
					<button type="submit" class="btw-action btw-send" disabled={busy() || !draft().trim()}>
						{composeLabel()}
					</button>
				</form>
			</div>
		</Modal>
	);
};
