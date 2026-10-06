import { For, Show, createEffect, on, type Component } from "solid-js";
import { formatTokens } from "../../usage/context";
import { state } from "../../state";
import { Modal } from "../shared/Modal";
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
} from "../../store/compaction";

/**
 * G13 explicit compaction + context maintenance controls (presentation only).
 *
 * Thin: every row reads a signal from store/compaction.ts and fires one of
 * its actions; no RPC, parsing, or eligibility logic lives here. Deliberately
 * NOT registered in overlays/index.ts (contract) and NOT mounted by App:
 * mount this component where the surface belongs and refresh eligibility on
 * open (onMount below). Focus return on close rides the shared Modal.
 * No global-shortcut traps; every control is a native keyboard element.
 */
export const CompactionControls: Component<{ onClose: () => void }> = (props) => {
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
				<fieldset class="compaction-modes" disabled={running()}>
					<legend class="stats-subhead">Mode</legend>
					<For each={COMPACTION_MODE_META}>
						{(meta) => (
							<label class="compaction-mode">
								<input
									type="radio"
									name="compaction-mode"
									value={meta.name}
									checked={selectedMode() === meta.name}
									disabled={!modeEligibility(meta.name).eligible}
									title={modeEligibility(meta.name).reason}
									onChange={() => selectCompactionMode(meta.name)}
								/>
								<span class="picker-label">{meta.name}</span>
								<span class="picker-detail">{meta.description}</span>
								<Show when={!modeEligibility(meta.name).eligible}>
									<span class="picker-detail">{modeEligibility(meta.name).reason}</span>
								</Show>
							</label>
						)}
					</For>
				</fieldset>

				<label class="compaction-focus">
					<span class="picker-label">Focus instructions</span>
					<input
						type="text"
						value={focusText()}
						disabled={focusDisabled() || running()}
						placeholder={
							focusDisabled()
								? "snapcompact takes no focus text (it archives history without an LLM summary)"
								: "optional focus for the summary"
						}
						aria-describedby="compaction-focus-hint"
						onInput={(e) => setCompactionFocus(e.currentTarget.value)}
					/>
					<Show when={focusDisabled()}>
						<span id="compaction-focus-hint" class="picker-detail">
							snapcompact rejects focus text: there is no LLM summary to direct.
						</span>
					</Show>
				</label>

				<div class="compaction-eligibility" role="status" aria-live="polite">
					<Show
						when={gate().eligible}
						fallback={<span class="msg-notice">{gate().reason ?? "Not eligible."}</span>}
					>
						<Show
							when={gate().interruptsTurn}
							fallback={
								<span class="picker-detail">Ready: mode and focus pass the local gate.</span>
							}
						>
							<span class="msg-notice">
								A turn is streaming: SDK compaction aborts it and may resume after commit.
							</span>
						</Show>
					</Show>
				</div>

				<div class="stats-actions">
					<Show
						when={!running()}
						fallback={
							<button
								type="button"
								disabled={progress().cancelRequested}
								onClick={cancelCompaction}
							>
								{progress().cancelRequested ? "Cancelling…" : "Cancel compaction"}
							</button>
						}
					>
						<button type="button" disabled={!gate().eligible} onClick={startCompaction}>
							Compact ({selectedMode()})
						</button>
					</Show>
					<Show when={running()}>
						<span class="picker-detail" role="status">
							Compacting with {selectedMode()}…
						</span>
					</Show>
				</div>

				<Show when={progress().phase === "cancelled"}>
					<div class="msg-notice" role="status">
						Compaction cancelled.
					</div>
				</Show>
				<Show when={compactionError()}>
					{(err) => (
						<div class="msg-notice" role="alert">
							{err()}
						</div>
					)}
				</Show>
				<Show when={result()}>
					{(view) => (
						<div class="compaction-result" role="status">
							<div class="picker-label">
								Requested {view().mode}; applied {view().appliedMethod ?? "SDK method not reported"}
								<Show when={view().tokensBefore !== undefined}>
									<span class="picker-detail">
										{" "}
										(estimate: {formatTokens(view().tokensBefore!)} before)
									</span>
								</Show>
							</div>
							<div class="compaction-summary">{view().summary}</div>
							<div class="picker-detail">
								Live model context changed; session identity and retained journal/history remain.
								Recent-context boundary: {view().firstKeptEntryId}.
							</div>
						</div>
					)}
				</Show>

				<Show when={preEstimate() ?? postEstimate()}>
					<div class="compaction-estimates">
						<h3 class="stats-subhead">Context estimates</h3>
						<Show when={preEstimate()}>
							{(pre) => (
								<div class="picker-detail">
									before (estimate): {formatTokens(pre().usedTokens)} /{" "}
									{formatTokens(pre().contextWindow)}
								</div>
							)}
						</Show>
						<Show when={postEstimate()}>
							{(post) => (
								<div class="picker-detail">
									after (estimate): {formatTokens(post().usedTokens)} /{" "}
									{formatTokens(post().contextWindow)}
								</div>
							)}
						</Show>
						<div class="picker-detail">{ESTIMATE_NOTE}</div>
					</div>
				</Show>

				<div class="compaction-handoff">
					<h3 class="stats-subhead">Handoff anchor</h3>
					<Show
						when={anchor()}
						fallback={<span class="picker-detail">Loading session identity…</span>}
					>
						{(a) => (
							<div class="picker-detail">
								session {a().sessionId || "(none attached)"}
								<Show when={a().leafId}> · leaf {a().leafId}</Show>
								<Show when={a().historyMessages !== null}> · {a().historyMessages} messages</Show>
								<div>
									Handoff keeps identity and {formatTokens(a().keepRecentTokens)} recent tokens
									(policy target). It reads a live snapshot without aborting an active turn; prompts
									wait for commit.
								</div>
								<Show when={!a().eligible}>
									<div>{a().reason}</div>
								</Show>
							</div>
						)}
					</Show>
				</div>

				<label class="toggle">
					<input
						type="checkbox"
						checked={state.autoCompactionEnabled}
						disabled={autoPending()}
						onChange={(e) => toggleAutoCompaction(e.currentTarget.checked)}
					/>
					auto-compaction
				</label>

				<div class="compaction-shake">
					<h3 class="stats-subhead">Trim without summarizing</h3>
					<div class="picker-detail">
						Mechanical trimming rewrites the current branch without a summary or a new session;
						image originals are retained in a session artifact. Wait for active turns before
						trimming.
					</div>
					<div class="stats-actions">
						<For each={SHAKE_MODE_META}>
							{(meta) => (
								<button
									type="button"
									title={meta.description}
									disabled={maintenanceBusy() || state.streaming}
									onClick={() => runShake(meta.name)}
								>
									shake {meta.name}
								</button>
							)}
						</For>
						<button
							type="button"
							title="Strip image content from the current branch"
							disabled={maintenanceBusy() || state.streaming}
							onClick={runDropImages}
						>
							drop images
						</button>
					</div>
					<Show when={shakeState().phase === "running"}>
						<span class="picker-detail" role="status">
							Shaking…
						</span>
					</Show>
					<Show when={shakeState().summary}>
						<div class="picker-detail" role="status">
							{shakeState().summary}
							<Show when={shakeState().tokensFreed !== undefined}>
								{" "}
								(estimate: ~{formatTokens(shakeState().tokensFreed!)} freed)
							</Show>
						</div>
					</Show>
					<Show when={shakeState().error}>
						<div class="msg-notice" role="alert">
							{shakeState().error}
						</div>
					</Show>
					<Show when={dropImagesState().phase === "done"}>
						<div class="picker-detail" role="status">
							Removed {dropImagesState().removed ?? 0} image
							{(dropImagesState().removed ?? 0) === 1 ? "" : "s"}.
						</div>
					</Show>
					<Show when={dropImagesState().error}>
						<div class="msg-notice" role="alert">
							{dropImagesState().error}
						</div>
					</Show>
				</div>
			</div>
		</Modal>
	);
};
