import {
	VOICE_BYTES_PER_SAMPLE,
	VOICE_DICTATION_BATCH_FRAMES,
	VOICE_FRAME_SAMPLES,
	VOICE_MAX_TURN_SECONDS,
	VOICE_MAX_UTTERANCE_BYTES,
	VOICE_MIN_BARGE_IN_LEVEL,
	VOICE_OUTPUT_ACTIVE_LEVEL,
	VOICE_OUTPUT_ECHO_RATIO,
	VOICE_REALTIME_WINDOW_FRAMES,
	VOICE_SAMPLE_RATE_HZ,
} from "#lib/wire/voice";
/**
 * G19 voice adapter (headless audio boundary, daemon side).
 *
 * No browser APIs here (no getUserMedia, AudioContext, MediaStream). This
 * module owns everything the daemon needs to (a) advertise voice capability
 * discovered from the REAL configured provider only, (b) bound the PCM it
 * accepts from the browser, and (c) shape the injection boundary for the
 * SDK's audio controllers WITHOUT editing the SDK:
 *
 * - STT dictation reuses `STTController` (pi-coding-agent `src/stt/
 *   stt-controller.ts`): its constructor already injects a `CaptureFactory`
 *   `(onAudio: (err, samples: Float32Array) => void) => { stop() }` plus the
 *   `SttTarget` / `SttCallbacks` / `SttState` (`idle|recording|transcribing`)
 *   triple, defaulting to `new AudioCapture(16_000, onAudio)` from
 *   pi-natives. The daemon microphone is NOT the browser microphone, so
 *   `createBtuCaptureSource()` below is the browser-frame-fed CaptureFactory
 *   the daemon hands to STTController instead of the native capture.
 * - Realtime voice reuses `LiveSessionController` (pi-coding-agent
 *   `src/live/controller.ts`): it constructs native `AudioCapture` and
 *   `CodexLiveTransport` (authStorage / sessionId / instructions / voice /
 *   onEvent / onOutputLevel callbacks) internally with NO audited browser
 *   injection API. `BrowserLiveInjection` below DEFINES the boundary P0/SDK
 *   must audit before any browser PCM reaches that transport; this file
 *   never constructs the transport and never holds credentials.
 *
 * Daemon-held credentials only: transports authenticate from the daemon's
 * own authStorage. Secrets/tokens never appear in DTOs, logs, or URLs.
 * Buffers are daemon-held in-memory Float32Array chunks, disposed on
 * cancel / sign-out / scope-switch / failure. No raw-audio persistence.
 *
 * Headless discovery rule: capability is derived from injected facts (the
 * caller reads settings/registry/auth), so this module stays side-effect
 * free and unit-testable with controlled fixtures. A real configured
 * supported provider is REQUIRED; anything else is explicit unavailable.
 * No SpeechRecognition fallback, no mock transcription.
 */

// ---------------------------------------------------------------------------
// Identity: scope + generation (never message text, list index, filename).
// ---------------------------------------------------------------------------

// Args scopes ride the daemon SessionScope (workspace/session/generation);
// VoiceScope partitions drafts client-side. The adapter accepts the daemon
// scope and derives the draft scope from its sessionId.
/** Client-supplied idempotency generation per start; stale generations are
 *  rejected so late frames from a prior attachment never update the session. */
export type VoiceGeneration = string;

// ---------------------------------------------------------------------------
// Capability: server-advertised, never guessed from version.
// ---------------------------------------------------------------------------

import type {
	DictationStatus,
	RealtimePhase,
	VoiceCapability,
	VoiceUnavailableReason,
	VoiceScope,
} from "#lib/wire/voice";
export type { VoiceCapability, VoiceUnavailableReason, VoiceScope };

/** Model APIs STTController actually supports (see its #start dispatch:
 *  `openai-transcriptions` = buffered cloud, `local-inference` = streaming
 *  local; anything else warns "Unsupported speech-to-text API"). */
export const SUPPORTED_STT_APIS = ["openai-transcriptions", "local-inference"] as const;

/** Facts the daemon collects from settings/registry/auth; injected so this
 *  stays headless and deterministic under test. */
export interface VoiceDiscoveryFacts {
	/** settings `stt.enabled` (cfgSttEnabled, default false). */
	sttEnabled: boolean;
	/** Resolved `dictation` role model api (roleCandidatePool + resolveRoleChain). */
	dictationModelApi?: string;
	/** Resolved `dictation` role model id (for logging only, never a secret). */
	dictationModelId?: string;
	/** Daemon holds usable live-call auth (Codex OAuth); never the token. */
	liveAuthPresent: boolean;
	/** False when the daemon runs with tools disabled: native-tool transports
	 *  that would dictate tools:false must surface as explicit unavailable. */
	toolsEnabled: boolean;
	/** Explicit configured auth input; never inferred from operator files. */
	dictationAuthPresent?: boolean;
	/** True only for an injected transport with browser PCM output and interrupt. */
	browserRealtimeAvailable?: boolean;
}

/** Headless discovery: real configured supported provider only. */
export function discoverVoiceCapability(facts: VoiceDiscoveryFacts): VoiceCapability {
	if (!facts.toolsEnabled)
		return { sttAvailable: false, liveAvailable: false, reason: "transport" };
	const sttAvailable =
		facts.sttEnabled &&
		facts.dictationModelApi !== undefined &&
		(SUPPORTED_STT_APIS as readonly string[]).includes(facts.dictationModelApi) &&
		facts.dictationAuthPresent === true;
	const liveAvailable = facts.liveAuthPresent && facts.browserRealtimeAvailable === true;
	if (!sttAvailable && !liveAvailable) return { sttAvailable, liveAvailable, reason: "provider" };
	if (!sttAvailable) return { sttAvailable, liveAvailable, reason: "provider" };
	if (!liveAvailable)
		return {
			sttAvailable,
			liveAvailable,
			reason: facts.liveAuthPresent ? "transport" : "provider",
		};
	return { sttAvailable, liveAvailable };
}

export { VOICE_FRAME_SAMPLES } from "#lib/wire/voice"; // 320

/** Assert the pipeline sample rate; Float32Array carries no rate metadata so
 *  every producer must declare it and the browser must resample to 16 kHz
 *  before framing. */
export function assertVoiceSampleRate(rateHz: number): void {
	if (rateHz !== VOICE_SAMPLE_RATE_HZ) {
		throw new Error(`voice: expected ${VOICE_SAMPLE_RATE_HZ} Hz PCM, got ${rateHz} Hz`);
	}
}

/** Clamped RMS level in [0,1] (mirrors LiveSessionController microphoneLevel). */
export function voiceRmsLevel(samples: Float32Array): number {
	if (samples.length === 0) return 0;
	let sumSquares = 0;
	for (let i = 0; i < samples.length; i++) {
		const s = samples[i] ?? 0;
		sumSquares += s * s;
	}
	const rms = Math.sqrt(sumSquares / samples.length);
	if (!Number.isFinite(rms) || rms <= 0) return 0;
	return Math.min(1, rms);
}

/** Barge-in: assistant-playback interrupt. While output is active, input
 *  below the echo-relative threshold is echo, not interruption. */
export function shouldInterruptPlayback(inputLevel: number, outputLevel: number): boolean {
	if (outputLevel <= VOICE_OUTPUT_ACTIVE_LEVEL) return false;
	return inputLevel >= Math.max(VOICE_MIN_BARGE_IN_LEVEL, outputLevel * VOICE_OUTPUT_ECHO_RATIO);
}

export interface BtuPushResult {
	acceptedSamples: number;
	/** Latched on first overflow: the adapter drops everything past the cap
	 *  and the caller MUST stop the flow (drop-and-stop). */
	overflow: boolean;
}

/**
 * Bounded PCM buffer owned by the adapter (daemon side). The transport owns
 * credentials; this owns bytes. Overflow latches: after the cap is hit every
 * push accepts 0 until reset(), so an unbounded browser stream can never grow
 * daemon memory.
 */
export class BtuPcmAdapter {
	readonly #maxBytes: number;
	readonly #maxSamples: number;
	#chunks: Float32Array[] = [];
	#samples = 0;
	#overflow = false;
	#disposed = false;

	constructor(options?: { maxUtteranceBytes?: number; maxTurnSeconds?: number }) {
		const capByTime =
			VOICE_SAMPLE_RATE_HZ *
			VOICE_BYTES_PER_SAMPLE *
			(options?.maxTurnSeconds ?? VOICE_MAX_TURN_SECONDS);
		this.#maxBytes = Math.min(
			options?.maxUtteranceBytes ?? VOICE_MAX_UTTERANCE_BYTES,
			VOICE_MAX_UTTERANCE_BYTES,
		);
		this.#maxSamples = Math.min(
			Math.floor(capByTime / VOICE_BYTES_PER_SAMPLE),
			Math.floor(this.#maxBytes / VOICE_BYTES_PER_SAMPLE),
		);
	}

	get bufferedSamples(): number {
		return this.#samples;
	}

	get bufferedSeconds(): number {
		return this.#samples / VOICE_SAMPLE_RATE_HZ;
	}

	get overflowed(): boolean {
		return this.#overflow;
	}

	push(samples: Float32Array): BtuPushResult {
		if (this.#disposed || this.#overflow || samples.length === 0) {
			return { acceptedSamples: 0, overflow: this.#overflow };
		}
		const room = this.#maxSamples - this.#samples;
		if (room <= 0) {
			this.#overflow = true;
			return { acceptedSamples: 0, overflow: true };
		}
		const take = Math.min(room, samples.length);
		this.#chunks.push(samples.slice(0, take));
		this.#samples += take;
		if (take < samples.length) this.#overflow = true;
		return { acceptedSamples: take, overflow: this.#overflow };
	}

	/** Concatenate buffered PCM (caller encodes/transcribes, then disposes). */
	drain(): Float32Array[] {
		return this.#chunks.splice(0, this.#chunks.length);
	}

	reset(): void {
		this.#chunks = [];
		this.#samples = 0;
		this.#overflow = false;
	}

	/** Drop all held bytes; idempotent. */
	dispose(): void {
		this.#chunks = [];
		this.#samples = 0;
		this.#disposed = true;
	}
}

// ---------------------------------------------------------------------------
// SDK injection boundary (no SDK edits, no SDK imports here).
// ---------------------------------------------------------------------------

/** Structural mirror of STTController's injected CaptureFactory. */
export type VoiceCaptureFactory = (
	onAudio: (error: Error | null, samples: Float32Array) => void,
) => { stop(): void };

/**
 * Browser-frame-fed capture source for STTController: the daemon constructs
 * `new STTController(source.factory, { settings, registry })` instead of the
 * default native `AudioCapture`, so browser PCM drives the REAL transcription
 * path (streaming local or buffered cloud, chosen by the dictation role
 * model). Daemon mic is never opened for browser dictation.
 */
export interface BtuCaptureSource {
	factory: VoiceCaptureFactory;
	/** Feed one 16 kHz mono browser frame (rate asserted). */
	feedFrame(samples: Float32Array): void;
	feedError(err: Error): void;
	stop(): void;
}

export function createBtuCaptureSource(): BtuCaptureSource {
	let onAudio: ((error: Error | null, samples: Float32Array) => void) | null = null;
	let stopped = false;
	return {
		factory: (cb) => {
			onAudio = cb;
			return {
				stop() {
					stopped = true;
					onAudio = null;
				},
			};
		},
		feedFrame(samples) {
			if (stopped) return;
			assertVoiceSampleRate(VOICE_SAMPLE_RATE_HZ); // pipeline contract, always 16k here
			onAudio?.(null, samples);
		},
		feedError(err) {
			if (stopped) return;
			onAudio?.(err, new Float32Array(0));
		},
		stop() {
			stopped = true;
			onAudio = null;
		},
	};
}

// ---------------------------------------------------------------------------
// DictationSession: daemon-held server shape.
// ---------------------------------------------------------------------------

export type { DictationStatus } from "#lib/wire/voice";

/** Server-side dictation session: buffers are daemon-held, disposed on
 *  cancel / sign-out / scope-switch / failure. Text identity is the stable
 *  `id`; scope+generation reject stale frames. */
export interface DictationSession {
	id: string;
	targetScope: VoiceScope;
	generation: VoiceGeneration;
	interimText: string;
	finalText?: string;
	status: DictationStatus;
}

/** In-memory dictation registry (per attached session entry). No persistence:
 *  raw audio never touches disk, localStorage, or IndexedDB. */
export class DictationSessionStore {
	readonly #sessions = new Map<string, { session: DictationSession; audio: BtuPcmAdapter }>();

	create(id: string, scope: VoiceScope, generation: VoiceGeneration): DictationSession {
		this.disposeScope(scope, "superseded");
		const session: DictationSession = {
			id,
			targetScope: scope,
			generation,
			interimText: "",
			status: "recording",
		};
		this.#sessions.set(id, { session, audio: new BtuPcmAdapter() });
		return session;
	}

	get(id: string): DictationSession | undefined {
		return this.#sessions.get(id)?.session;
	}

	appendPcm(id: string, generation: VoiceGeneration, samples: Float32Array): BtuPushResult {
		const entry = this.#sessions.get(id);
		if (!entry || entry.session.generation !== generation || entry.session.status !== "recording") {
			return { acceptedSamples: 0, overflow: false };
		}
		return entry.audio.push(samples);
	}

	appendInterim(id: string, generation: VoiceGeneration, text: string): void {
		const entry = this.#sessions.get(id);
		if (!entry || entry.session.generation !== generation || entry.session.status !== "recording")
			return;
		entry.session.interimText = text;
	}

	markTranscribing(id: string): void {
		const entry = this.#sessions.get(id);
		if (entry && entry.session.status === "recording") entry.session.status = "transcribing";
	}

	commit(id: string, finalText: string): DictationSession | undefined {
		const entry = this.#sessions.get(id);
		if (!entry || (entry.session.status !== "recording" && entry.session.status !== "transcribing"))
			return undefined;
		entry.session.finalText = finalText;
		entry.session.status = "committed";
		entry.audio.dispose();
		return entry.session;
	}

	cancel(id: string): void {
		const entry = this.#sessions.get(id);
		if (!entry) return;
		entry.session.status = "cancelled";
		entry.audio.dispose();
		this.#sessions.delete(id);
	}

	/** Dispose every session in a scope (scope-switch / sign-out). `reason`
	 *  is for logs only (stderr, never stdout). */
	disposeScope(
		scope: VoiceScope,
		_reason: "superseded" | "scope-switch" | "sign-out" | "failure",
	): void {
		for (const [id, entry] of this.#sessions) {
			if (entry.session.targetScope.sessionId === scope.sessionId) {
				entry.audio.dispose();
				this.#sessions.delete(id);
			}
		}
	}

	disposeAll(): void {
		for (const [, entry] of this.#sessions) entry.audio.dispose();
		this.#sessions.clear();
	}
}

// ---------------------------------------------------------------------------
// Realtime transport spec (authenticated bounded channel).
// ---------------------------------------------------------------------------

/** Realtime phases mirror LiveSessionController's LivePhase. */
export type { RealtimePhase } from "#lib/wire/voice";

/** Daemon-held realtime session (control state; audio frames are bounded and
 *  acked, never buffered unbounded). */
export interface RealtimeSession {
	id: string;
	targetScope: VoiceScope;
	generation: VoiceGeneration;
	/** Monotonic role-local turn number coalescing streaming updates. */
	turnId: number;
	muted: boolean;
	phase: RealtimePhase;
	/** Unacked frame count for window flow control (cap VOICE_REALTIME_WINDOW_FRAMES). */
	unackedFrames: number;
	nextSeq: number;
}

// ---------------------------------------------------------------------------
// Proposed additive DTOs / wirings for P0 to publish (OMP_PROTO stays 2).
// P0 owns lib/wire/protocol.ts + methods dispatch; this file only proposes.
// ---------------------------------------------------------------------------

/** Proposed WebMethodName rows (all optional/additive, Capability-gated): */
export const VOICE_P0_METHODS = [
	"voiceCapability",
	"voiceDictationStart",
	"voiceDictationFrame",
	"voiceDictationCommit",
	"voiceDictationCancel",
	"voiceRealtimeStart",
	"voiceRealtimeFrame",
	"voiceRealtimeInterrupt",
	"voiceRealtimeMute",
	"voiceRealtimeStop",
] as const;

/** Proposed additive SSE ServerFrames (optional, Capability-gated): */
export const VOICE_P0_FRAMES = [
	"voice_capability",
	"voice_dictation_delta",
	"voice_realtime_event",
] as const;

export interface VoiceDictationStartArgs {
	scope: import("#lib/wire/protocol").SessionScope;
	generation: VoiceGeneration;
}
export interface VoiceDictationStartResult {
	dictationId: string;
}
export interface VoiceDictationFrameArgs {
	dictationId: string;
	generation: VoiceGeneration;
	/** Monotonic frame seq; server acks the highest contiguous seq. */
	seq: number;
	/** Base64 16-bit mono PCM @16 kHz (bounded batch, see spec below). */
	pcm16Base64: string;
	sampleRateHz: number;
}
export interface VoiceDictationCommitArgs {
	dictationId: string;
	generation: VoiceGeneration;
	scope: import("#lib/wire/protocol").SessionScope;
}
export interface VoiceDictationCommitResult {
	text: string;
}
export interface VoiceDictationCancelArgs {
	dictationId: string;
	generation: VoiceGeneration;
	scope: import("#lib/wire/protocol").SessionScope;
}
export interface VoiceDictationDeltaFrame {
	type: "voice_dictation_delta";
	dictationId: string;
	generation: string;
	scope: import("#lib/wire/protocol").SessionScope;
	interim: string;
	final: boolean;
}
export interface VoiceRealtimeStartArgs {
	scope: import("#lib/wire/protocol").SessionScope;
	generation: VoiceGeneration;
	voice?: string;
}
export interface VoiceRealtimeStartResult {
	realtimeId: string;
	turnId: number;
}
export interface VoiceRealtimeFrameArgs {
	realtimeId: string;
	generation: VoiceGeneration;
	seq: number;
	pcm16Base64: string;
	sampleRateHz: number;
}
export interface VoiceRealtimeFrameResult {
	ackSeq: number;
	window: number;
}
export interface VoiceRealtimeInterruptArgs {
	realtimeId: string;
	generation: VoiceGeneration;
	turnId: number;
}
export interface VoiceRealtimeMuteArgs {
	realtimeId: string;
	generation: VoiceGeneration;
	muted: boolean;
}
export interface VoiceRealtimeStopArgs {
	realtimeId: string;
	generation: VoiceGeneration;
}
export interface VoiceRealtimeEventFrame {
	type: "voice_realtime_event";
	realtimeId: string;
	generation: string;
	scope: import("#lib/wire/protocol").SessionScope;
	phase: RealtimePhase;
	turnId: number;
	inputLevel?: number;
	outputLevel?: number;
	transcript?: { role: "user" | "assistant"; text: string; final: boolean };
	/** Optional bounded assistant-audio playback chunk (base64 PCM16 @16k). */
	audioBase64?: string;
}

/**
 * Transport flow spec (for P0 + apps/web/store/voice.ts):
 *
 * - Control rides existing POST /command `call` id-dedup semantics
 *   (client-supplied id, 202 accept, answers on /events as call_result).
 *   Audio NEVER routes through arbitrary agent prompts.
 * - Dictation uplink: 20 ms frames (320 samples, 640 B PCM16, ~854 chars
 *   base64) batched 5 per `voiceDictationFrame` call (100 ms audio/call);
 *   server transcribes via the STTController path and emits interim/final
 *   `voice_dictation_delta` frames. Commit returns final text; cancel
 *   disposes daemon buffers.
 * - Realtime uplink: one `voiceRealtimeFrame` per 20 ms frame with
 *   monotonic seq; server answers `{ ackSeq, window }` per call_result.
 *   Client keeps at most VOICE_REALTIME_WINDOW_FRAMES (50, ~1 s) unacked;
 *   while the window is full it drops new frames and counts overruns
 *   (never grows memory, never blocks capture).
 * - Turn/interrupt identity: `{ realtimeId, turnId }`; interrupt targets
 *   the exact turn (barge-in or explicit button). Stale generation frames
 *   are rejected so late events from a prior attachment never update state.
 * - Playback: assistant audio arrives as bounded `audioBase64` chunks on
 *   `voice_realtime_event`; the browser schedules them and reports output
 *   level for echo-aware barge-in (shouldInterruptPlayback).
 * - Mute/stop/disconnect: `voiceRealtimeMute` toggles capture server-side;
 *   `voiceRealtimeStop` closes the turn and disposes; browser disconnect
 *   (sign-out / scope-switch / failure) stops tracks + AudioContext +
 *   buffers and best-effort stops the server flow.
 */
export const VOICE_TRANSPORT_SPEC =
	"G19 bounded control+frames over POST /command id-dedup" as const;

export interface BrowserRealtimeProvider {
	pushAudio(samples: Float32Array): void;
	setMuted(muted: boolean): Promise<void>;
	interrupt(turnId: number): Promise<void>;
	close(): Promise<void>;
}

export interface VoiceAdapterDependencies {
	sttDependencies: import("@oh-my-pi/pi-coding-agent/stt/stt-controller").STTControllerDependencies;
	discovery(): VoiceDiscoveryFacts;
	emit(frame: VoiceDictationDeltaFrame | VoiceRealtimeEventFrame): void;
	/** Real authenticated provider boundary. Must emit PCM16 mono @16k,
	 * implement exact-turn interruption and never open the daemon microphone.
	 * The pinned native Codex transport cannot fulfill this contract. */
	realtimeProvider?: (
		args: VoiceRealtimeStartArgs,
		emit: (
			event: Omit<VoiceRealtimeEventFrame, "type" | "realtimeId" | "generation" | "scope">,
		) => void,
	) => Promise<BrowserRealtimeProvider>;
}

/** Per attachment, real SDK STT with a browser-fed capture and unsent target. */
export interface VoiceAdapter {
	capability: () => VoiceCapability;
	dictationStart(args: VoiceDictationStartArgs): Promise<VoiceDictationStartResult>;
	dictationFrame(args: VoiceDictationFrameArgs): unknown;
	dictationCommit(args: VoiceDictationCommitArgs): Promise<VoiceDictationCommitResult>;
	dictationCancel(args: { dictationId: string; generation: string }): void;
	realtimeStart(args: VoiceRealtimeStartArgs): Promise<VoiceRealtimeStartResult>;
	realtimeFrame(args: VoiceRealtimeFrameArgs): unknown;
	realtimeInterrupt(args: VoiceRealtimeInterruptArgs): Promise<void>;
	realtimeMute(args: VoiceRealtimeMuteArgs): Promise<void>;
	realtimeStop(args: VoiceRealtimeStopArgs): Promise<void>;
	dispose(): Promise<void>;
}

/** Per attachment, real SDK STT with a browser-fed capture and unsent target. */
export function createVoiceAdapter(deps: VoiceAdapterDependencies): VoiceAdapter {
	type Flow = {
		session: DictationSession;
		source: BtuCaptureSource;
		controller: import("@oh-my-pi/pi-coding-agent/stt/stt-controller").STTController;
		seq: number;
		samples: number;
		committed: string;
		failure?: Error;
	};
	const dictations = new Map<string, Flow>();
	const live = new Map<
		string,
		{
			args: VoiceRealtimeStartArgs;
			provider: BrowserRealtimeProvider;
			seq: number;
			samples: number;
			turnId: number;
			outputLevel: number;
			muted: boolean;
		}
	>();
	const capability = () =>
		discoverVoiceCapability({
			...deps.discovery(),
			browserRealtimeAvailable: Boolean(deps.realtimeProvider),
		});
	function decode(pcm: string, rate: number, maxSamples: number): Float32Array {
		assertVoiceSampleRate(rate);
		if (
			!pcm ||
			pcm.length > Math.ceil((maxSamples * 2) / 3) * 4 ||
			!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(pcm)
		)
			throw new Error("voice unavailable: codec");
		const bytes = Buffer.from(pcm, "base64");
		if (bytes.length % 2 || bytes.length > maxSamples * 2)
			throw new Error("voice unavailable: codec");
		const result = new Float32Array(bytes.length / 2);
		for (let i = 0; i < result.length; i++) result[i] = bytes.readInt16LE(i * 2) / 32768;
		return result;
	}
	function dictation(args: { dictationId: string; generation: string }): Flow {
		const flow = dictations.get(args.dictationId);
		if (!flow || flow.session.generation !== args.generation)
			throw new Error("voice unavailable: stale generation");
		return flow;
	}
	function cancel(args: { dictationId: string; generation: string }): void {
		const flow = dictation(args);
		dictations.delete(args.dictationId);
		flow.source.stop();
		flow.controller.dispose();
		flow.committed = "";
		flow.session.interimText = "";
	}
	return {
		capability,
		async dictationStart(args: VoiceDictationStartArgs): Promise<VoiceDictationStartResult> {
			if (!capability().sttAvailable) throw new Error("voice unavailable: provider");
			for (const [id, flow] of dictations)
				cancel({ dictationId: id, generation: flow.session.generation });
			const { STTController } = await import("@oh-my-pi/pi-coding-agent/stt/stt-controller");
			const source = createBtuCaptureSource();
			const id = crypto.randomUUID();
			const session: DictationSession = {
				id,
				targetScope: args.scope,
				generation: args.generation,
				interimText: "",
				status: "recording",
			};
			const controller = new STTController(source.factory, {
				...deps.sttDependencies,
				getSessionId: () => args.scope.sessionId,
			});
			const flow: Flow = { session, source, controller, seq: 0, samples: 0, committed: "" };
			dictations.set(id, flow);
			const emit = () => {
				if (dictations.get(id) !== flow) return;
				deps.emit({
					type: "voice_dictation_delta",
					dictationId: id,
					generation: args.generation,
					scope: args.scope,
					interim: flow.committed + session.interimText,
					final: controller.state === "idle",
				});
			};
			try {
				await controller.start(
					{
						setVolatileText(text) {
							session.interimText = text;
							emit();
						},
						clearVolatileText() {
							session.interimText = "";
							emit();
						},
						commitVolatileText(text) {
							flow.committed += text;
							session.interimText = "";
							emit();
						},
						submit() {
							/* Deliberately unsent: SDK submit triggers never execute an agent prompt. */
						},
						deleteBeforeCursor(count) {
							flow.committed = flow.committed.slice(0, Math.max(0, flow.committed.length - count));
							emit();
						},
					},
					{
						showWarning(message) {
							flow.failure = new Error(message);
							source.stop();
						},
						showStatus() {},
						onStateChange(status) {
							if (status === "transcribing") session.status = "transcribing";
							emit();
						},
					},
				);
				if (flow.failure || controller.state !== "recording")
					throw flow.failure ?? new Error("voice unavailable: provider");
				return { dictationId: id };
			} catch (error) {
				cancel({ dictationId: id, generation: args.generation });
				throw error;
			}
		},
		dictationFrame(args: VoiceDictationFrameArgs) {
			const flow = dictation(args);
			if (args.seq !== flow.seq) throw new Error("voice unavailable: frame sequence");
			try {
				const pcm = decode(
					args.pcm16Base64,
					args.sampleRateHz,
					VOICE_FRAME_SAMPLES * VOICE_DICTATION_BATCH_FRAMES,
				);
				flow.samples += pcm.length;
				if (flow.samples > VOICE_SAMPLE_RATE_HZ * VOICE_MAX_TURN_SECONDS)
					throw new Error("voice unavailable: utterance limit");
				flow.source.feedFrame(pcm);
				if (flow.failure) throw flow.failure;
				return { ackSeq: flow.seq++, window: 1 };
			} catch (error) {
				cancel(args);
				throw error;
			}
		},
		async dictationCommit(args: VoiceDictationCommitArgs): Promise<VoiceDictationCommitResult> {
			const flow = dictation(args);
			try {
				await flow.controller.stop();
				if (flow.failure) throw flow.failure;
				return { text: flow.committed + flow.session.interimText };
			} finally {
				if (dictations.get(args.dictationId) === flow) cancel(args);
			}
		},
		dictationCancel: cancel,
		async realtimeStart(args: VoiceRealtimeStartArgs): Promise<VoiceRealtimeStartResult> {
			if (!capability().liveAvailable || !deps.realtimeProvider)
				throw new Error("voice unavailable: transport");
			const id = crypto.randomUUID();
			const provider = await deps.realtimeProvider(args, (event) => {
				const flow = live.get(id);
				if (!flow) return;
				flow.turnId = event.turnId;
				flow.outputLevel = event.outputLevel ?? flow.outputLevel;
				if (event.audioBase64)
					decode(event.audioBase64, VOICE_SAMPLE_RATE_HZ, VOICE_SAMPLE_RATE_HZ);
				deps.emit({
					...event,
					type: "voice_realtime_event",
					realtimeId: id,
					generation: args.generation,
					scope: args.scope,
				});
			});
			live.set(id, { args, provider, seq: 0, samples: 0, turnId: 0, outputLevel: 0, muted: false });
			return { realtimeId: id, turnId: 0 };
		},
		realtimeFrame(args: VoiceRealtimeFrameArgs): VoiceRealtimeFrameResult {
			const flow = live.get(args.realtimeId);
			if (!flow || flow.args.generation !== args.generation || flow.seq !== args.seq)
				throw new Error("voice unavailable: stale frame");
			try {
				const pcm = decode(args.pcm16Base64, args.sampleRateHz, VOICE_FRAME_SAMPLES);
				flow.samples += pcm.length;
				if (flow.samples > VOICE_SAMPLE_RATE_HZ * VOICE_MAX_TURN_SECONDS)
					throw new Error("voice unavailable: turn limit");
				if (!flow.muted) {
					if (shouldInterruptPlayback(voiceRmsLevel(pcm), flow.outputLevel))
						void flow.provider.interrupt(flow.turnId);
					flow.provider.pushAudio(pcm);
				}
				return { ackSeq: flow.seq++, window: 1 };
			} catch (error) {
				live.delete(args.realtimeId);
				void flow.provider.close();
				throw error;
			}
		},
		async realtimeInterrupt(args: VoiceRealtimeInterruptArgs) {
			const flow = live.get(args.realtimeId);
			if (!flow || flow.args.generation !== args.generation || flow.turnId !== args.turnId)
				throw new Error("voice unavailable: stale turn");
			await flow.provider.interrupt(args.turnId);
			flow.samples = 0;
		},
		async realtimeMute(args: VoiceRealtimeMuteArgs) {
			const flow = live.get(args.realtimeId);
			if (!flow || flow.args.generation !== args.generation)
				throw new Error("voice unavailable: stale generation");
			await flow.provider.setMuted(args.muted);
			flow.muted = args.muted;
		},
		async realtimeStop(args: VoiceRealtimeStopArgs) {
			const flow = live.get(args.realtimeId);
			if (!flow || flow.args.generation !== args.generation) return;
			live.delete(args.realtimeId);
			await flow.provider.close();
		},
		async dispose() {
			for (const [id, flow] of dictations)
				cancel({ dictationId: id, generation: flow.session.generation });
			const providers = [...live.values()];
			live.clear();
			await Promise.all(providers.map((flow) => flow.provider.close()));
		},
	};
}
