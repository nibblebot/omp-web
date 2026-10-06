import type { SessionScope } from "#lib/wire/protocol";

// Browser-safe voice wire vocabulary (G19). Daemon-only behavior
// (STTController, capture sources, provider transports) stays in
// apps/session/voice-adapter.ts, which the browser bundle MUST NOT import:
// the SDK package maps to src/*.ts, so any transitive SDK import pulls
// node:/bun: modules and non-JS assets (.md/.py) into the vite build.

/** Explicit unavailable vocabulary (no fake provider, no silent fallback). */
export type VoiceUnavailableReason =
	| "denied"
	| "codec"
	| "browser"
	| "insecure"
	| "provider"
	| "transport";

/** Additive capability DTO (voiceCapability result). */
export interface VoiceCapability {
	sttAvailable: boolean;
	liveAvailable: boolean;
	reason?: VoiceUnavailableReason;
}

export type DictationStatus = "recording" | "transcribing" | "committed" | "cancelled";

export type RealtimePhase = "connecting" | "listening" | "working" | "speaking" | "muted" | "error";

/** Draft-ownership scope for a voice flow (partitions Main vs side work). */
export interface VoiceScope {
	sessionId: string;
	branchId?: string;
	agentId?: string;
}

/** Client-supplied idempotency generation per start. */
export type VoiceGeneration = string;

/** Canonical voice sample rate (matches STTController + LiveSessionController). */
export const VOICE_SAMPLE_RATE_HZ = 16_000;
/** One realtime audio frame: 20 ms at 16 kHz mono. */
export const VOICE_FRAME_MS = 20;
export const VOICE_FRAME_SAMPLES = (VOICE_SAMPLE_RATE_HZ * VOICE_FRAME_MS) / 1000; // 320
/** Bytes per 16-bit mono sample. */
export const VOICE_BYTES_PER_SAMPLE = 2;
/** Max single utterance/turn: 120 s of 16-bit mono (7.68 MiB cap). */
export const VOICE_MAX_TURN_SECONDS = 120;
export const VOICE_MAX_UTTERANCE_BYTES =
	VOICE_SAMPLE_RATE_HZ * VOICE_BYTES_PER_SAMPLE * VOICE_MAX_TURN_SECONDS;
/** Realtime flow-control window: max unacked frames (~1 s of audio). */
export const VOICE_REALTIME_WINDOW_FRAMES = 50;
/** Dictation uplink batches 5 frames (100 ms) per control call. */
export const VOICE_DICTATION_BATCH_FRAMES = 5;
/** Barge-in thresholds, mirrored from LiveSessionController. */
export const VOICE_OUTPUT_ACTIVE_LEVEL = 0.015;
export const VOICE_MIN_BARGE_IN_LEVEL = 0.04;
export const VOICE_OUTPUT_ECHO_RATIO = 0.65;

export type { SessionScope };
