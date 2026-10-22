/**
 * Prompt directives: how a scenario tells the fake model which shape to produce.
 *
 * The fake model reads one `@@profile {json}` line out of the user prompt. The
 * response is then a pure function of the request: the directive plus the
 * conversation position (how many assistant messages follow the directive
 * message). Directives never carry timing, and nothing about them is written
 * into model text, so transcripts stay free of profiling markers.
 *
 * Every builder takes a `route`: the label the caller uses for the session it is
 * about to prompt (for example the daemon id). The fake model stamps it on every
 * send-log line, and the client uses the same label when it joins received
 * deltas back (see `joinLatency` in `../latency.ts`). Subagents spawned by a
 * `subagentTurn` get the route `<route>/sub<k>`.
 */

/** Marker that precedes the JSON directive on its own prompt line. */
export const DIRECTIVE_MARKER = "@@profile";

/** Streamed text: one assistant text block of `chars` characters. */
export interface TextDirective {
	kind: "text";
	route: string;
	/** Total characters of the assistant text block. */
	chars: number;
	/** Characters per streamed content chunk. */
	chunkChars: number;
	/** Chunk emission rate. 0 emits chunks back to back (paced only by backpressure). */
	deltasPerSec: number;
}

/**
 * Tool-heavy turn: `calls` real `bash` calls, then a short text answer. The SDK
 * caps the stdout it puts in the tool result (about 50 KB, measured), so
 * `outputBytes` beyond that is produced by the command but truncated in the
 * result that reaches the wire and the next request.
 */
export interface ToolDirective {
	kind: "tool";
	route: string;
	/** Number of `bash` calls. */
	calls: number;
	/** Exact bytes of stdout each call produces. */
	outputBytes: number;
	/** One assistant message carrying every call (true) or one call per assistant message (false). */
	parallel: boolean;
	/** Characters of the final text answer after the last tool result. */
	finalChars: number;
}

/** Subagent fan-out: one `task` call spawning `agents` subagents that each stream text. */
export interface SubagentDirective {
	kind: "subagent";
	route: string;
	/** Number of subagents spawned by the single `task` call. */
	agents: number;
	/** Characters of text each subagent streams. */
	textChars: number;
	chunkChars: number;
	deltasPerSec: number;
	/** Characters of the parent's final text answer after the subagents return. */
	finalChars: number;
}

/** Minimal answer: a single short text chunk. */
export interface IdleDirective {
	kind: "idle";
	route: string;
}

export type Directive = TextDirective | ToolDirective | SubagentDirective | IdleDirective;

/** Default final-answer length for tool and subagent turns. */
const DEFAULT_FINAL_CHARS = 120;

function encode(directive: Directive): string {
	return `Follow the profiling directive below exactly.\n${DIRECTIVE_MARKER} ${JSON.stringify(directive)}`;
}

/** Prompt that makes the fake model stream one text block of `chars` characters. */
export function textTurn(opts: {
	route: string;
	chars: number;
	chunkChars: number;
	deltasPerSec: number;
}): string {
	return encode({ kind: "text", ...opts });
}

/** Prompt that makes the fake model run `calls` real `bash` calls of `outputBytes` stdout each. */
export function toolTurn(opts: {
	route: string;
	calls: number;
	outputBytes: number;
	parallel?: boolean;
	finalChars?: number;
}): string {
	return encode({
		kind: "tool",
		route: opts.route,
		calls: opts.calls,
		outputBytes: opts.outputBytes,
		parallel: opts.parallel ?? false,
		finalChars: opts.finalChars ?? DEFAULT_FINAL_CHARS,
	});
}

/** Prompt that makes the fake model spawn `agents` subagents streaming `textChars` each. */
export function subagentTurn(opts: {
	route: string;
	agents: number;
	textChars: number;
	chunkChars?: number;
	deltasPerSec?: number;
	finalChars?: number;
}): string {
	return encode({
		kind: "subagent",
		route: opts.route,
		agents: opts.agents,
		textChars: opts.textChars,
		chunkChars: opts.chunkChars ?? 40,
		deltasPerSec: opts.deltasPerSec ?? 50,
		finalChars: opts.finalChars ?? DEFAULT_FINAL_CHARS,
	});
}

/** Prompt that makes the fake model answer with one short chunk. */
export function idleTurn(opts: { route: string }): string {
	return encode({ kind: "idle", route: opts.route });
}

/** The directive in `text`, or `undefined` when the text carries none (or a malformed one). */
export function parseDirective(text: string): Directive | undefined {
	const at = text.lastIndexOf(DIRECTIVE_MARKER);
	if (at < 0) return undefined;
	const lineEnd = text.indexOf("\n", at);
	const json = text.slice(at + DIRECTIVE_MARKER.length, lineEnd < 0 ? undefined : lineEnd).trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return undefined;
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("kind" in parsed) ||
		!("route" in parsed)
	) {
		return undefined;
	}
	if (typeof parsed.route !== "string") return undefined;
	switch (parsed.kind) {
		case "text":
		case "tool":
		case "subagent":
		case "idle":
			return parsed as Directive;
		default:
			return undefined;
	}
}
