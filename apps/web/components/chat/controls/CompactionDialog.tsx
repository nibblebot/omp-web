import { For, Show, createEffect, on, type Component } from "solid-js";
import { formatTokens } from "../../../usage/context";
import { state } from "../../../state";
import { Modal } from "../../ui/Modal";
import {
	COMPACTION_MODE_META,
	ESTIMATE_NOTE,
	SHAKE_MODE_META,
	anchor,
	autoPending,
	cancelCompaction,
	compactionError,
	dropImagesState,
	eligibility,
	focusText,
	maintenanceBusy,
	modeEligibility,
	postEstimate,
	preEstimate,
	progress,
	refreshCompactionEligibility,
	result,
	runDropImages,
	runShake,
	selectCompactionMode,
	selectedMode,
	setCompactionFocus,
	shakeState,
	startCompaction,
	toggleAutoCompaction,
	type CompactionModeName,
} from "../../../store/compaction";

/** Plain names for the Advanced method list; descriptions come from COMPACTION_MODE_META. */
const MODE_TITLE: Record<CompactionModeName, string> = {
	soft: "Summarize with the current model",
	remote: "Provider compaction",
	snapcompact: "Image archive",
};

/**
 * Compaction dialog (CMD-12): one recommended action with before/after
 * estimates; the other methods, auto-compaction, and trim tools sit under
 * Advanced. Presentation only: every control reads a store signal and fires
 * one store action; no RPC or eligibility logic lives here. ModalHost mounts
 * it for the `compaction` modal. Eligibility refreshes on session/model/
 * streaming changes (effect below). The result lands as a marker card in the
 * transcript, so this dialog only confirms it.
 */
export const CompactionDialog: Component<{ onClose: () => void }> = (props) => {
	createEffect(
		on(
			() => [state.sessionId, state.model?.id, state.streaming, state.compacting] as const,
			() => {
				void refreshCompactionEligibility();
			},
		),
	);

	const gate = () => eligibility();
	const running = () => progress().phase === "running";
	const focusDisabled = () =>
		COMPACTION_MODE_META.find((m) => m.name === selectedMode())?.rejectsFocus === true;

	return (
		<Modal title="Compact context" onClose={props.onClose}>
			<div class="compaction-controls">
				<Show when={preEstimate()}>
					{(pre) => (
						<p class="compaction-estimates">
							Before: about {formatTokens(pre().usedTokens)} of {formatTokens(pre().contextWindow)}{" "}
							tokens used
							<Show when={postEstimate()}>
								{(post) => <> · after: about {formatTokens(post().usedTokens)}</>}
							</Show>
							<span class="picker-detail"> (estimate)</span>
						</p>
					)}
				</Show>

				<p class="picker-detail">
					{COMPACTION_MODE_META.find((m) => m.name === selectedMode())?.description}
				</p>

				<label class="compaction-focus">
					<span class="picker-label">Focus (optional)</span>
					<input
						type="text"
						value={focusText()}
						disabled={focusDisabled() || running()}
						placeholder="What the summary should keep, for example API decisions"
						aria-describedby={focusDisabled() ? "compaction-focus-hint" : undefined}
						onInput={(e) => setCompactionFocus(e.currentTarget.value)}
					/>
					<Show when={focusDisabled()}>
						<span id="compaction-focus-hint" class="picker-detail">
							This method takes no focus text.
						</span>
					</Show>
				</label>

				<Show when={!gate().eligible}>
					<p class="msg-notice" role="status">
						{gate().reason ?? "Not eligible."}
					</p>
				</Show>
				<Show when={gate().eligible && gate().interruptsTurn}>
					<p class="msg-notice" role="status">
						A reply is streaming. Compacting stops it, and it resumes after the summary is saved.
					</p>
				</Show>

				<div class="compaction-actions">
					<Show
						when={!running()}
						fallback={
							<button
								type="button"
								disabled={progress().cancelRequested}
								onClick={cancelCompaction}
							>
								{progress().cancelRequested ? "Cancelling…" : "Cancel"}
							</button>
						}
					>
						<button
							type="button"
							class="compaction-run"
							disabled={!gate().eligible}
							title={gate().eligible ? undefined : gate().reason}
							onClick={startCompaction}
						>
							Compact
						</button>
					</Show>
					<Show when={running()}>
						<span class="picker-detail" role="status">
							Compacting…
						</span>
					</Show>
				</div>

				<Show when={progress().phase === "cancelled"}>
					<p class="msg-notice" role="status">
						Compaction cancelled.
					</p>
				</Show>
				<Show when={compactionError()}>
					{(err) => (
						<p class="msg-notice" role="alert">
							{err()}
						</p>
					)}
				</Show>
				<Show when={result()}>
					{(view) => (
						<p class="compaction-done" role="status">
							Compacted
							{view().tokensBefore !== undefined
								? ` from ${formatTokens(view().tokensBefore!)}`
								: ""}
							. The summary is in the transcript as a marker you can expand.
						</p>
					)}
				</Show>

				<details class="compaction-advanced">
					<summary>Advanced</summary>

					<fieldset class="compaction-modes" disabled={running()}>
						<legend class="picker-label">Method</legend>
						<For each={COMPACTION_MODE_META}>
							{(meta) => (
								<label class="compaction-mode">
									<input
										type="radio"
										name="compaction-mode"
										value={meta.name}
										checked={selectedMode() === meta.name}
										disabled={!modeEligibility(meta.name).eligible}
										onChange={() => selectCompactionMode(meta.name)}
									/>
									<span class="picker-label">{MODE_TITLE[meta.name]}</span>
									<span class="picker-detail">{meta.description}</span>
									<Show when={!modeEligibility(meta.name).eligible}>
										<span class="picker-detail">{modeEligibility(meta.name).reason}</span>
									</Show>
								</label>
							)}
						</For>
					</fieldset>

					<Show when={anchor()}>
						{(a) => (
							<p class="picker-detail">
								Handoff keeps this session's identity and about {formatTokens(a().keepRecentTokens)}{" "}
								recent tokens. It reads a live snapshot without aborting an active reply.
								<Show when={!a().eligible}>
									<span> {a().reason}</span>
								</Show>
							</p>
						)}
					</Show>

					<label class="toggle">
						<input
							type="checkbox"
							checked={state.autoCompactionEnabled}
							disabled={autoPending()}
							onChange={(e) => toggleAutoCompaction(e.currentTarget.checked)}
						/>
						Compact automatically when the context fills up
					</label>

					<div class="compaction-shake">
						<h3 class="stats-subhead">Trim without summarizing</h3>
						<p class="picker-detail">
							Trimming rewrites the current branch without a summary or a new session. Image
							originals are kept in a session artifact. Wait for active replies first.
						</p>
						<div class="compaction-actions">
							<For each={SHAKE_MODE_META}>
								{(meta) => (
									<button
										type="button"
										title={meta.description}
										disabled={maintenanceBusy() || state.streaming}
										onClick={() => runShake(meta.name)}
									>
										Shake: {meta.name}
									</button>
								)}
							</For>
							<button
								type="button"
								title="Strip image content from the current branch"
								disabled={maintenanceBusy() || state.streaming}
								onClick={runDropImages}
							>
								Drop images
							</button>
						</div>
						<Show when={shakeState().phase === "running"}>
							<span class="picker-detail" role="status">
								Trimming…
							</span>
						</Show>
						<Show when={shakeState().summary}>
							<p class="picker-detail" role="status">
								{shakeState().summary}
								<Show when={shakeState().tokensFreed !== undefined}>
									{" "}
									(estimate: about {formatTokens(shakeState().tokensFreed!)} freed)
								</Show>
							</p>
						</Show>
						<Show when={shakeState().error}>
							<p class="msg-notice" role="alert">
								{shakeState().error}
							</p>
						</Show>
						<Show when={dropImagesState().phase === "done"}>
							<p class="picker-detail" role="status">
								Removed {dropImagesState().removed ?? 0} image
								{(dropImagesState().removed ?? 0) === 1 ? "" : "s"}.
							</p>
						</Show>
						<Show when={dropImagesState().error}>
							<p class="msg-notice" role="alert">
								{dropImagesState().error}
							</p>
						</Show>
					</div>
				</details>

				<p class="picker-detail">{ESTIMATE_NOTE}</p>
			</div>
		</Modal>
	);
};
