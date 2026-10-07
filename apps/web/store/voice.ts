import { createSignal } from "solid-js";
import { setPromptInsert } from "./chat";
import { call } from "./transport";
import type {
	DictationStatus,
	RealtimePhase,
	VoiceCapability,
	VoiceUnavailableReason,
} from "#lib/wire/voice";
import type { SessionScope } from "#lib/wire/protocol";
import {
	VOICE_BYTES_PER_SAMPLE,
	VOICE_DICTATION_BATCH_FRAMES,
	VOICE_FRAME_SAMPLES,
	VOICE_REALTIME_WINDOW_FRAMES,
	VOICE_SAMPLE_RATE_HZ,
} from "#lib/wire/voice";
/**
 * G19 voice store (browser capture lifecycle, daemon-agnostic side).
 * Owns the browser half of dictation + realtime voice: permission/device/
 * capture UI state, getUserMedia lifecycle, 16 kHz framing, bounded uplink,
 * and disposal. Control rides the existing POST /command `call` id-dedup
 * path; audio frames ride additive `voice*` methods (Capability-gated, P0
 * publishes them). Downlink `voice_*` SSE frames are ingested here via
 * `ingestVoiceFrame()` — the /events mux owner (state.ts, another lane)
 * forwards them; this module never touches the mux.
 *
 * Rules: getUserMedia ONLY after an explicit user action (every entry point
 * is a click/key handler); secure-context gate; dictation lands in the
 * editable UNSENT composer via the promptInsert inbox (never auto-submit);
 * no raw-audio persistence (in-memory PCM only, cleared on dispose; never
 * localStorage/IndexedDB); hold-to-talk never traps Space typing.
 */

// ---------------------------------------------------------------------------
// Method names: proposed additive rows for P0 (cast until published).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// UI state (transient presentation mirrors; components own nothing else).
// ---------------------------------------------------------------------------

export type MicPermission = "unknown" | "prompt" | "granted" | "denied";
export type CaptureState = "idle" | "requesting" | "capturing";
export type DictationUiStatus = "idle" | DictationStatus;
export type RealtimeUiStatus = "idle" | "active";

export const [micPermission, setMicPermission] = createSignal<MicPermission>("unknown");
export const [captureState, setCaptureState] = createSignal<CaptureState>("idle");
export const [capability, setCapability] = createSignal<VoiceCapability | null>(null);
export const [voiceUnavailable, setVoiceUnavailable] = createSignal<VoiceUnavailableReason | null>(
	null,
);
export const [dictationStatus, setDictationStatus] = createSignal<DictationUiStatus>("idle");
export const [dictationInterim, setDictationInterim] = createSignal("");
export const [realtimeStatus, setRealtimeStatus] = createSignal<RealtimeUiStatus>("idle");
export const [realtimePhase, setRealtimePhase] = createSignal<RealtimePhase>("connecting");
export const [realtimeMuted, setRealtimeMuted] = createSignal(false);
export const [realtimeInputLevel, setRealtimeInputLevel] = createSignal(0);
export const [realtimeOutputLevel, setRealtimeOutputLevel] = createSignal(0);

function markUnavailable(reason: VoiceUnavailableReason): void {
	setVoiceUnavailable(reason);
}

// ---------------------------------------------------------------------------
// Module-level capture graph (never in signals; disposed wholesale).
// ---------------------------------------------------------------------------

interface CaptureGraph {
	stream: MediaStream;
	ctx: AudioContext;
	processor: ScriptProcessorNode;
	source: MediaStreamAudioSourceNode;
}

let capture: CaptureGraph | null = null;
let dictationId: string | null = null;
let dictationScope: SessionScope | null = null;
let dictationGeneration = "";
let dictationSeq = 0;
let dictationBatch: Float32Array[] = [];
let dictationBatchSamples = 0;
let dictationStopped = false;
let realtimeId: string | null = null;
let realtimeScope: SessionScope | null = null;
let realtimeGeneration = "";
let realtimeTurnId = 0;
let realtimeSeq = 0;
let realtimeUnacked = 0;
let realtimeOverruns = 0;
let realtimePlayback: { ctx: AudioContext; cursor: number } | null = null;
let holdActive = false;

// ---------------------------------------------------------------------------
// Capability (server-advertised; never guessed from version).
// ---------------------------------------------------------------------------

/** Refresh the advertised voice capability; maps transport failure to
 *  explicit unavailable instead of guessing. */
export async function refreshVoiceCapability(): Promise<void> {
	try {
		const cap = (await call("voiceCapability", [], 10_000)) as VoiceCapability;
		setCapability(cap);
		if (!cap.sttAvailable && !cap.liveAvailable) markUnavailable(cap.reason ?? "provider");
		else setVoiceUnavailable(null);
	} catch {
		setCapability(null);
		markUnavailable("transport");
	}
}

// ---------------------------------------------------------------------------
// Mic access: explicit user gesture + secure context only.
// ---------------------------------------------------------------------------

function secureContextOk(): boolean {
	if (typeof window !== "undefined" && window.isSecureContext) return true;
	markUnavailable("insecure");
	return false;
}

function mapGetUserMediaError(err: unknown): VoiceUnavailableReason {
	const name = err instanceof DOMException ? err.name : err instanceof Error ? err.name : "";
	if (name === "NotAllowedError" || name === "SecurityError") {
		setMicPermission("denied");
		return "denied";
	}
	if (name === "NotFoundError" || name === "OverconstrainedError") {
		setMicPermission("prompt");
		return "browser";
	}
	if (name === "NotSupportedError" || name === "TypeError") return "browser";
	return "browser";
}

/**
 * Request microphone capture. MUST be called from a user gesture (click /
 * key). Resolves with a live capture graph; rejects with an explicit
 * unavailable reason already surfaced in state (no throw-and-forget).
 */
export async function requestMic(): Promise<CaptureGraph> {
	if (!secureContextOk()) throw new Error("voice unavailable: insecure context");
	if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
		markUnavailable("browser");
		throw new Error("voice unavailable: no capture API in this browser");
	}
	setCaptureState("requesting");
	let stream: MediaStream;
	try {
		stream = await navigator.mediaDevices.getUserMedia({
			audio: { sampleRate: VOICE_SAMPLE_RATE_HZ, channelCount: 1, echoCancellation: true },
		});
	} catch (err) {
		setCaptureState("idle");
		markUnavailable(mapGetUserMediaError(err));
		throw new Error(`voice unavailable: ${String(err)}`);
	}
	setMicPermission("granted");
	// Prefer a native 16 kHz context; resample below when the device insists
	// on its own rate (Safari/Windows often run 44.1/48 kHz).
	const ctx = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE_HZ });
	const source = ctx.createMediaStreamSource(stream);
	const processor = ctx.createScriptProcessor(4096, 1, 1);
	source.connect(processor);
	processor.connect(ctx.destination);
	setCaptureState("capturing");
	capture = { stream, ctx, processor, source };
	return capture;
}

/** Linear resample one mono block to 16 kHz (no-op when already 16 kHz). */
function toVoiceRate(block: Float32Array, fromHz: number): Float32Array {
	if (fromHz === VOICE_SAMPLE_RATE_HZ) return block;
	const ratio = fromHz / VOICE_SAMPLE_RATE_HZ;
	const outLen = Math.max(1, Math.floor(block.length / ratio));
	const out = new Float32Array(outLen);
	for (let i = 0; i < outLen; i++) {
		const pos = i * ratio;
		const lo = Math.floor(pos);
		const frac = pos - lo;
		const a = block[lo] ?? 0;
		const b = block[lo + 1] ?? a;
		out[i] = a + (b - a) * frac;
	}
	return out;
}

function floatToPcm16Base64(samples: Float32Array): string {
	const pcm = new Int16Array(samples.length);
	for (let i = 0; i < samples.length; i++) {
		const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
		pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
	}
	const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
	let bin = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK)
		bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	return btoa(bin);
}

function base64ToFloat32(b64: string): Float32Array {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	const pcm = new Int16Array(
		bytes.buffer,
		bytes.byteOffset,
		Math.floor(bytes.byteLength / VOICE_BYTES_PER_SAMPLE),
	);
	const out = new Float32Array(pcm.length);
	for (let i = 0; i < pcm.length; i++) out[i] = (pcm[i] ?? 0) / 0x8000;
	return out;
}

function stopCaptureGraph(): void {
	const c = capture;
	capture = null;
	if (!c) {
		setCaptureState("idle");
		return;
	}
	try {
		c.processor.disconnect();
	} catch {
		/* already torn down */
	}
	try {
		c.source.disconnect();
	} catch {
		/* already torn down */
	}
	for (const track of c.stream.getTracks()) track.stop();
	void c.ctx.close().catch(() => {});
	setCaptureState("idle");
}

// ---------------------------------------------------------------------------
// Dictation: interim editable scoped draft, accept commits, cancel clears.
// ---------------------------------------------------------------------------

/** Start dictation into an editable unsent scoped draft. User gesture only. */
export async function startDictation(scope: SessionScope): Promise<void> {
	if (dictationStatus() !== "idle") return;
	const cap = capability();
	if (cap && !cap.sttAvailable) {
		markUnavailable(cap.reason ?? "provider");
		return;
	}
	const generation = crypto.randomUUID();
	let start: { dictationId: string };
	try {
		start = (await call("voiceDictationStart", [{ scope, generation }], 15_000)) as {
			dictationId: string;
		};
	} catch {
		markUnavailable("transport");
		return;
	}
	let graph: CaptureGraph;
	try {
		graph = await requestMic();
	} catch {
		void call(
			"voiceDictationCancel",
			[{ dictationId: start.dictationId, generation, scope }],
			5_000,
		).catch(() => {});
		return;
	}
	dictationId = start.dictationId;
	dictationScope = scope;
	dictationGeneration = generation;
	dictationSeq = 0;
	dictationBatch = [];
	dictationBatchSamples = 0;
	dictationStopped = false;
	setDictationStatus("recording");
	setDictationInterim("");
	const rateHz = graph.ctx.sampleRate;
	let carry = new Float32Array(0);
	graph.processor.onaudioprocess = (ev) => {
		if (dictationStopped || !dictationId) return;
		const mono = ev.inputBuffer.getChannelData(0);
		const at16k = toVoiceRate(mono, rateHz);
		const joined = new Float32Array(carry.length + at16k.length);
		joined.set(carry, 0);
		joined.set(at16k, carry.length);
		let off = 0;
		while (off + VOICE_FRAME_SAMPLES <= joined.length) {
			const frame = joined.slice(off, off + VOICE_FRAME_SAMPLES);
			off += VOICE_FRAME_SAMPLES;
			dictationBatch.push(frame);
			dictationBatchSamples += VOICE_FRAME_SAMPLES;
			if (dictationBatch.length >= VOICE_DICTATION_BATCH_FRAMES) flushDictationBatch();
		}
		carry = joined.slice(off);
	};
}

function flushDictationBatch(): void {
	if (dictationStopped || !dictationId || dictationBatch.length === 0) {
		dictationBatch = [];
		dictationBatchSamples = 0;
		return;
	}
	const total = dictationBatchSamples;
	const joined = new Float32Array(total);
	let off = 0;
	for (const f of dictationBatch) {
		joined.set(f, off);
		off += f.length;
	}
	dictationBatch = [];
	dictationBatchSamples = 0;
	const id = dictationId;
	const generation = dictationGeneration;
	const seq = dictationSeq++;
	void call(
		"voiceDictationFrame",
		[
			{
				dictationId: id,
				generation,
				seq,
				pcm16Base64: floatToPcm16Base64(joined),
				sampleRateHz: VOICE_SAMPLE_RATE_HZ,
			},
		],
		15_000,
	).catch(() => {
		// Uplink loss surfaces as a failed/stale flow; stop capturing rather
		// than buffering unbounded audio the server will never transcribe.
		if (dictationId === id) void stopDictation({ accept: false });
	});
}

/** Stop dictation: accept commits interim+final into the UNSENT scoped draft
 *  (composer, editable, never submitted); cancel clears and disposes. */
export async function stopDictation(opts: { accept: boolean }): Promise<void> {
	const status = dictationStatus();
	if (status === "idle") return;
	dictationStopped = true;
	const id = dictationId;
	const scope = dictationScope;
	const generation = dictationGeneration;
	dictationId = null;
	dictationScope = null;
	stopCaptureGraph();
	setDictationStatus("idle");
	if (!id || !scope) {
		setDictationInterim("");
		return;
	}
	if (!opts.accept) {
		setDictationInterim("");
		void call("voiceDictationCancel", [{ dictationId: id, generation, scope }], 5_000).catch(
			() => {},
		);
		return;
	}
	try {
		const result = (await call(
			"voiceDictationCommit",
			[{ dictationId: id, generation, scope }],
			30_000,
		)) as {
			text?: string;
		};
		const text = `${dictationInterim()} ${result.text ?? ""}`.trim();
		setDictationInterim("");
		if (text) setPromptInsert({ text });
	} catch {
		setDictationInterim("");
		markUnavailable("transport");
	}
}

/** Cancel dictation from scope-switch / sign-out / failure paths. */
export function cancelDictation(): void {
	if (dictationStatus() === "idle") return;
	void stopDictation({ accept: false });
}

// ---------------------------------------------------------------------------
// Realtime: bounded frames with ack/window, interrupt, mute, stop.
// ---------------------------------------------------------------------------

/** Start realtime voice. User gesture only; opens capture + playback. */
export async function startRealtime(scope: SessionScope, opts?: { voice?: string }): Promise<void> {
	if (realtimeStatus() !== "idle") return;
	const cap = capability();
	if (cap && !cap.liveAvailable) {
		markUnavailable(cap.reason ?? "provider");
		return;
	}
	const generation = crypto.randomUUID();
	let start: { realtimeId: string; turnId: number };
	try {
		start = (await call(
			"voiceRealtimeStart",
			[{ scope, generation, voice: opts?.voice }],
			20_000,
		)) as {
			realtimeId: string;
			turnId: number;
		};
	} catch {
		markUnavailable("transport");
		return;
	}
	let graph: CaptureGraph;
	try {
		graph = await requestMic();
	} catch {
		void call("voiceRealtimeStop", [{ realtimeId: start.realtimeId, generation }], 5_000).catch(
			() => {},
		);
		return;
	}
	realtimeId = start.realtimeId;
	realtimeScope = scope;
	realtimeGeneration = generation;
	realtimeTurnId = start.turnId;
	realtimeSeq = 0;
	realtimeUnacked = 0;
	realtimeOverruns = 0;
	setRealtimeStatus("active");
	setRealtimePhase("connecting");
	setRealtimeMuted(false);
	const rateHz = graph.ctx.sampleRate;
	let carry = new Float32Array(0);
	graph.processor.onaudioprocess = (ev) => {
		if (!realtimeId) return;
		if (realtimeUnacked >= VOICE_REALTIME_WINDOW_FRAMES) {
			realtimeOverruns++;
			return; // window full: drop, count, never buffer unbounded
		}
		const mono = ev.inputBuffer.getChannelData(0);
		const at16k = toVoiceRate(mono, rateHz);
		const joined = new Float32Array(carry.length + at16k.length);
		joined.set(carry, 0);
		joined.set(at16k, carry.length);
		let off = 0;
		while (off + VOICE_FRAME_SAMPLES <= joined.length) {
			if (realtimeUnacked >= VOICE_REALTIME_WINDOW_FRAMES) {
				realtimeOverruns++;
				break;
			}
			const frame = joined.slice(off, off + VOICE_FRAME_SAMPLES);
			off += VOICE_FRAME_SAMPLES;
			sendRealtimeFrame(frame);
		}
		carry = joined.slice(off);
	};
	// Playback graph: assistant audio chunks scheduled gaplessly.
	const playCtx = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE_HZ });
	realtimePlayback = { ctx: playCtx, cursor: playCtx.currentTime + 0.05 };
}

function sendRealtimeFrame(frame: Float32Array): void {
	const id = realtimeId;
	if (!id) return;
	const generation = realtimeGeneration;
	const seq = realtimeSeq++;
	realtimeUnacked++;
	void call(
		"voiceRealtimeFrame",
		[
			{
				realtimeId: id,
				generation,
				seq,
				pcm16Base64: floatToPcm16Base64(frame),
				sampleRateHz: VOICE_SAMPLE_RATE_HZ,
			},
		],
		10_000,
	)
		.then((res) => {
			const ack = res as { ackSeq?: number; window?: number } | undefined;
			if (realtimeId === id) realtimeUnacked = Math.max(0, realtimeUnacked - 1);
			if (typeof ack?.window === "number" && ack.window < 0) realtimeUnacked = 0;
		})
		.catch(() => {
			if (realtimeId === id) realtimeUnacked = Math.max(0, realtimeUnacked - 1);
		});
}

/** Barge-in / explicit interrupt of the current assistant turn. */
export function interruptRealtime(): void {
	const id = realtimeId;
	if (!id || realtimeStatus() === "idle") return;
	void call(
		"voiceRealtimeInterrupt",
		[{ realtimeId: id, generation: realtimeGeneration, turnId: realtimeTurnId }],
		5_000,
	).catch(() => {});
}

/** Toggle microphone capture server-side (output stays connected). */
export function muteRealtime(muted: boolean): void {
	const id = realtimeId;
	if (!id || realtimeStatus() === "idle") return;
	setRealtimeMuted(muted);
	void call(
		"voiceRealtimeMute",
		[{ realtimeId: id, generation: realtimeGeneration, muted }],
		5_000,
	).catch(() => {
		setRealtimeMuted(!muted);
	});
}

/** Stop the realtime turn and dispose capture + playback + buffers. */
export function stopRealtime(): void {
	const id = realtimeId;
	const generation = realtimeGeneration;
	realtimeId = null;
	realtimeScope = null;
	realtimeUnacked = 0;
	stopCaptureGraph();
	const pb = realtimePlayback;
	realtimePlayback = null;
	if (pb) void pb.ctx.close().catch(() => {});
	setRealtimeStatus("idle");
	setRealtimePhase("connecting");
	setRealtimeMuted(false);
	setRealtimeInputLevel(0);
	setRealtimeOutputLevel(0);
	if (id) void call("voiceRealtimeStop", [{ realtimeId: id, generation }], 5_000).catch(() => {});
}

// ---------------------------------------------------------------------------
// Downlink ingest (forwarded by the /events mux owner; never muxed here).
// ---------------------------------------------------------------------------

export interface VoiceDictationDelta {
	type: "voice_dictation_delta";
	dictationId: string;
	interim: string;
	final: boolean;
}

export interface VoiceRealtimeEvent {
	type: "voice_realtime_event";
	realtimeId: string;
	phase: RealtimePhase;
	turnId: number;
	inputLevel?: number;
	outputLevel?: number;
	transcript?: { role: "user" | "assistant"; text: string; final: boolean };
	audioBase64?: string;
}

/** Route one additive voice SSE frame. Stale ids never touch live state:
 *  a delta for a finished/unknown flow is dropped. */
export function ingestVoiceFrame(frame: VoiceDictationDelta | VoiceRealtimeEvent): void {
	if (frame.type === "voice_dictation_delta") {
		if (frame.dictationId !== dictationId || dictationStatus() === "idle") return;
		setDictationInterim(frame.interim);
		if (frame.final) setDictationStatus("transcribing");
		return;
	}
	if (frame.realtimeId !== realtimeId || realtimeStatus() === "idle") return;
	setRealtimePhase(frame.phase);
	if (typeof frame.inputLevel === "number") setRealtimeInputLevel(frame.inputLevel);
	if (typeof frame.outputLevel === "number") setRealtimeOutputLevel(frame.outputLevel);
	if (frame.turnId !== realtimeTurnId) {
		realtimeTurnId = frame.turnId;
		realtimeUnacked = 0;
	}
	if (frame.audioBase64) schedulePlayback(frame.audioBase64);
	if (frame.transcript?.final && frame.transcript.role === "assistant")
		setRealtimePhase("listening");
}

function schedulePlayback(audioBase64: string): void {
	const pb = realtimePlayback;
	if (!pb) return;
	try {
		const samples = base64ToFloat32(audioBase64);
		const buf = pb.ctx.createBuffer(1, samples.length, VOICE_SAMPLE_RATE_HZ);
		buf.getChannelData(0).set(samples);
		const src = pb.ctx.createBufferSource();
		src.buffer = buf;
		src.connect(pb.ctx.destination);
		pb.cursor = Math.max(pb.cursor, pb.ctx.currentTime + 0.01);
		src.start(pb.cursor);
		pb.cursor += buf.duration;
	} catch {
		/* corrupt chunk: skip, keep the call alive */
	}
}

// ---------------------------------------------------------------------------
// Hold-to-talk: explicit button binding that never traps Space typing.
// ---------------------------------------------------------------------------

/**
 * Key handlers for an EXPLICIT hold button (the component spreads these on
 * the button only). No global Space listener exists anywhere in this module:
 * ordinary Space typing in the composer is untouched. preventDefault fires
 * only for the configured hold key while held on the focused button.
 */
export function holdKeyHandlers(
	scope: SessionScope,
	holdKey = " ",
): { onKeyDown: (e: KeyboardEvent) => void; onKeyUp: (e: KeyboardEvent) => void } {
	return {
		onKeyDown: (e) => {
			if (e.key !== holdKey || e.repeat || holdActive) return;
			e.preventDefault();
			holdActive = true;
			void startDictation(scope);
		},
		onKeyUp: (e) => {
			if (e.key !== holdKey || !holdActive) return;
			e.preventDefault();
			holdActive = false;
			void stopDictation({ accept: true });
		},
	};
}

// ---------------------------------------------------------------------------
// Lifecycle: cancel / sign-out / scope-switch / failure / disconnect.
// ---------------------------------------------------------------------------

/** Scope switch: dispose flows bound to any other session. Late events from
 *  the prior attachment never update the current session (id guards above). */
export function onVoiceScopeSwitch(sessionId: string): void {
	if (dictationScope && dictationScope.sessionId !== sessionId) cancelDictation();
	if (realtimeScope && realtimeScope.sessionId !== sessionId) stopRealtime();
}

/** Full teardown: tracks + AudioContexts + buffers; best-effort server stop.
 *  The sign-out owner calls this (auth state lives outside this module). */
export function disconnectVoice(): void {
	holdActive = false;
	dictationStopped = true;
	dictationId = null;
	dictationScope = null;
	dictationBatch = [];
	dictationBatchSamples = 0;
	setDictationStatus("idle");
	setDictationInterim("");
	stopRealtime();
	stopCaptureGraph();
	setMicPermission("unknown");
}
