import type { RealtimePhase, VoiceCapability, VoiceUnavailableReason } from "#lib/wire/voice";
import { VoiceControls } from "../../../../web/components/chat/composer/VoiceControls";
import type {
	CaptureState,
	DictationUiStatus,
	MicPermission,
	RealtimeUiStatus,
} from "../../../../web/store/voice";
import {
	setCaptureState,
	setCapability,
	setDictationInterim,
	setDictationStatus,
	setMicPermission,
	setRealtimeInputLevel,
	setRealtimeMuted,
	setRealtimeOutputLevel,
	setRealtimePhase,
	setRealtimeStatus,
	setVoiceUnavailable,
} from "../../../../web/store/voice";
import {
	voiceCapabilityPartial,
	voiceCapabilityReady,
	voiceScope,
} from "../../../fixtures/overlays";
import { answerCalls } from "../../../daemon";
import { defineStory } from "../../../registry";

/**
 * Voice signals live in the voice store, outside the reset state snapshot, so
 * every variant sets all of them: a variant never inherits another's flow.
 */
interface VoicePatch {
	capability?: VoiceCapability | null;
	unavailable?: VoiceUnavailableReason | null;
	mic?: MicPermission;
	capture?: CaptureState;
	dictation?: DictationUiStatus;
	interim?: string;
	realtime?: RealtimeUiStatus;
	phase?: RealtimePhase;
	muted?: boolean;
	input?: number;
	output?: number;
}

function seedVoice(patch: VoicePatch): void {
	setCapability(patch.capability ?? null);
	setVoiceUnavailable(patch.unavailable ?? null);
	setMicPermission(patch.mic ?? "granted");
	setCaptureState(patch.capture ?? "idle");
	setDictationStatus(patch.dictation ?? "idle");
	setDictationInterim(patch.interim ?? "");
	setRealtimeStatus(patch.realtime ?? "idle");
	setRealtimePhase(patch.phase ?? "connecting");
	setRealtimeMuted(patch.muted ?? false);
	setRealtimeInputLevel(patch.input ?? 0);
	setRealtimeOutputLevel(patch.output ?? 0);
}

export default defineStory({
	id: "chat-composer-voice-controls",
	title: "VoiceControls",
	component: {
		file: "apps/web/components/chat/composer/VoiceControls.tsx",
		export: "VoiceControls",
	},
	seed: { currentSessionId: "sess_09a41c" },
	variants: [
		{
			name: "Dictation and live ready",
			description: "Both voice paths available; microphone already granted.",
			seed: () => {
				answerCalls({});
				seedVoice({ capability: voiceCapabilityReady });
			},
			render: () => <VoiceControls scope={voiceScope} />,
		},
		{
			name: "Live unavailable",
			description: "Speech-to-text works; the realtime provider is down.",
			seed: () => {
				answerCalls({});
				seedVoice({ capability: voiceCapabilityPartial });
			},
			render: () => <VoiceControls scope={voiceScope} />,
		},
		{
			name: "Dictating",
			seed: () => {
				answerCalls({});
				seedVoice({
					capability: voiceCapabilityReady,
					capture: "capturing",
					dictation: "recording",
					interim: "Refactor the session store so resume",
				});
			},
			render: () => <VoiceControls scope={voiceScope} />,
		},
		{
			name: "Realtime listening",
			seed: () => {
				answerCalls({});
				seedVoice({
					capability: voiceCapabilityReady,
					capture: "capturing",
					realtime: "active",
					phase: "listening",
					input: 0.42,
					output: 0,
				});
			},
			render: () => <VoiceControls scope={voiceScope} />,
		},
		{
			name: "Realtime speaking, muted",
			seed: () => {
				answerCalls({});
				seedVoice({
					capability: voiceCapabilityReady,
					realtime: "active",
					phase: "speaking",
					muted: true,
					output: 0.63,
				});
			},
			render: () => <VoiceControls scope={voiceScope} />,
		},
		{
			name: "Microphone denied",
			seed: () => {
				answerCalls({});
				seedVoice({
					capability: { sttAvailable: false, liveAvailable: false, reason: "denied" },
					unavailable: "denied",
					mic: "denied",
				});
			},
			render: () => <VoiceControls scope={voiceScope} />,
		},
	],
});
