import { createEffect, createSignal, Show, type Component } from "solid-js";
import { setPromptInsert } from "../../state";
import {
	capability,
	captureState,
	dictationInterim,
	dictationStatus,
	holdKeyHandlers,
	interruptRealtime,
	micPermission,
	muteRealtime,
	realtimeInputLevel,
	realtimeMuted,
	realtimeOutputLevel,
	realtimePhase,
	realtimeStatus,
	refreshVoiceCapability,
	startDictation,
	startRealtime,
	stopDictation,
	stopRealtime,
	voiceUnavailable,
} from "../../store/voice";
import type { VoiceUnavailableReason } from "#lib/wire/voice";

/**
 * G19 voice controls (thin presentation; no state ownership).
 *
 * Renders permission/device/capture state, the dictation draft box
 * (editable, accept/cancel), realtime status (phase, levels, mute), and
 * explicit unavailable reasons with remediation. All capture lifecycle and
 * disposal lives in ../../store/voice; this component never touches
 * getUserMedia, MediaStream, or AudioContext directly.
 *
 * Deliberately NOT registered in overlays/index.ts or the modal system:
 * embed it next to the composer or in a settings surface.
 */

const REMEDIATION: Record<VoiceUnavailableReason, string> = {
	denied:
		"Microphone permission was denied. Allow it in the browser site settings, then try again.",
	browser: "This browser exposes no microphone capture API. Use a recent Chrome, Edge, or Firefox.",
	insecure: "Microphone capture needs a secure context. Open this app over HTTPS or localhost.",
	codec: "This device reports no usable audio codec or sample rate for 16 kHz capture.",
	provider:
		"No speech provider is configured. Enable speech-to-text and pick a dictation model in Settings.",
	transport: "The voice control channel is unreachable. Reconnect, then retry.",
};

export const VoiceControls: Component<{
	scope: import("#lib/wire/protocol").SessionScope;
}> = (props) => {
	const holdHandlers = holdKeyHandlers(props.scope);
	// Editable local override of the server-driven interim: while the user
	// has not typed, the box mirrors live interim; the first keystroke wins
	// and accept commits the edited text instead of the server transcript.
	const [draft, setDraft] = createSignal("");
	const [edited, setEdited] = createSignal(false);
	createEffect(() => {
		if (!edited()) setDraft(dictationInterim());
	});

	const dictating = () => dictationStatus() !== "idle";
	const live = () => realtimeStatus() !== "idle";

	const acceptDictation = async () => {
		const override = edited() ? draft().trim() : "";
		setEdited(false);
		if (override) {
			await stopDictation({ accept: false });
			setPromptInsert({ text: override });
		} else {
			await stopDictation({ accept: true });
		}
	};

	return (
		<section class="voice-controls" aria-label="Voice controls">
			<Show when={voiceUnavailable()}>
				{(reason) => <div class="msg-notice">Voice unavailable: {REMEDIATION[reason()]} </div>}
			</Show>
			<div class="voice-row">
				<span class="voice-state">
					mic: {micPermission()} · capture: {captureState()}
				</span>
				<button type="button" onClick={() => void refreshVoiceCapability()}>
					Recheck
				</button>
			</div>

			<div class="voice-row" aria-label="Dictation">
				<Show
					when={dictating()}
					fallback={
						<>
							<button
								type="button"
								onClick={() => void startDictation(props.scope)}
								disabled={capability()?.sttAvailable === false}
								title={
									capability()?.sttAvailable === false
										? REMEDIATION[capability()?.reason ?? "provider"]
										: "Dictate"
								}
							>
								Dictate
							</button>
							<button
								type="button"
								{...holdHandlers}
								title="Hold to talk (button-scoped; Space typing elsewhere is unaffected)"
							>
								Hold to talk
							</button>
						</>
					}
				>
					<button type="button" onClick={() => void acceptDictation()}>
						Accept
					</button>
					<button
						type="button"
						onClick={() => void stopDictation({ accept: false }).then(() => setEdited(false))}
					>
						Cancel
					</button>
				</Show>
			</div>
			<Show when={dictating()}>
				<label class="voice-draft">
					Dictation draft (editable, unsent — never auto-submitted)
					<textarea
						value={draft()}
						rows={3}
						onInput={(e) => {
							setEdited(true);
							setDraft(e.currentTarget.value);
						}}
					/>
				</label>
			</Show>

			<div class="voice-row" aria-label="Realtime voice">
				<Show
					when={live()}
					fallback={
						<button
							type="button"
							onClick={() => void startRealtime(props.scope)}
							disabled={capability()?.liveAvailable === false}
							title={
								capability()?.liveAvailable === false
									? REMEDIATION[capability()?.reason ?? "provider"]
									: "Start realtime voice"
							}
						>
							Start realtime
						</button>
					}
				>
					<span class="voice-state">
						{realtimePhase()}
						<Show when={realtimeMuted()}> · muted</Show>
					</span>
					<button type="button" onClick={() => interruptRealtime()}>
						Interrupt
					</button>
					<button type="button" onClick={() => muteRealtime(!realtimeMuted())}>
						{realtimeMuted() ? "Unmute" : "Mute"}
					</button>
					<button type="button" onClick={() => stopRealtime()}>
						Stop
					</button>
				</Show>
			</div>
			<Show when={live()}>
				<div class="voice-levels" aria-hidden="true">
					<div class="voice-meter">
						in <span style={{ width: `${Math.round(realtimeInputLevel() * 100)}%` }} />
					</div>
					<div class="voice-meter">
						out <span style={{ width: `${Math.round(realtimeOutputLevel() * 100)}%` }} />
					</div>
				</div>
			</Show>
		</section>
	);
};
