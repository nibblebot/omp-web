/**
 * Deterministic fake OpenAI chat-completions server for the profiling harness.
 *
 * Speaks the streaming wire the SDK's `openai-completions` client parses
 * (`data: {chat.completion.chunk}` SSE, `finish_reason`, a trailing usage chunk,
 * `[DONE]`). The response is a pure function of the request body: the profiling
 * directive in the prompt (`./directives.ts`) plus how many assistant messages
 * the conversation already holds. Nothing is random except text drawn from a
 * PRNG seeded by (route, request ordinal), so concurrent sessions and subagents
 * never influence each other.
 *
 * Send log: one NDJSON line per emitted text chunk, written to `sendLog`
 * (`{ route, req, contentIndex, offset, sendNs }`). `req` is the 0-based count of
 * assistant messages already in the request's `messages`; `offset` is the
 * cumulative characters of that content block after the chunk; `sendNs` is
 * `monotonicNs()` (`../clock.ts`: CLOCK_MONOTONIC, comparable across processes,
 * unlike Bun's process-relative `process.hrtime.bigint()`) as a decimal string,
 * stamped immediately before the chunk is written to the socket. Requests
 * without a directive (SDK side requests such as tool-descriptor compression)
 * are answered with a short fixed text and not logged. Tool-call chunks are not
 * logged: the wire carries no delta for them, so there is nothing to join.
 */
import { monotonicNs } from "../clock";
import { DIRECTIVE_MARKER, type TextDirective } from "./directives";
import type { Analysis, Position, ToolOffer } from "./parse";
import type { ParseJob, ParseResult } from "./parse-worker";

export interface FakeModel {
	/** Server origin, for example `http://127.0.0.1:41234` (the provider base URL is `<url>/v1`). */
	url: string;
	/** Flush the send log to disk without closing. */
	flush(): Promise<void>;
	/** Stop the server and flush the send log. */
	close(): Promise<void>;
}

export interface FakeModelOptions {
	port?: number;
	hostname?: string;
	/** NDJSON send log path; truncated at start. */
	sendLog: string;
}

/** Final answer streamed after tool results / subagent results (chars per chunk, chunks per second). */
const FINAL_CHUNK_CHARS = 40;
const FINAL_DELTAS_PER_SEC = 50;
/** Text of the aux answer for requests without a directive. */
const AUX_TEXT = "ok";
/** Stdout bytes per generated line, newline included. */
const LINE_BYTES = 64;
const LINE_PAD = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRS";
const CREATED = 1_700_000_000;

const WORDS = [
	"alpha",
	"bravo",
	"charlie",
	"delta",
	"echo",
	"foxtrot",
	"golf",
	"hotel",
	"india",
	"juliet",
	"kilo",
	"lima",
	"mike",
	"november",
	"oscar",
	"papa",
	"quebec",
	"romeo",
	"sierra",
	"tango",
	"uniform",
	"victor",
	"whiskey",
	"xray",
	"yankee",
	"zulu",
	"stream",
	"frame",
	"socket",
	"buffer",
	"signal",
	"render",
];

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** `chars` characters of deterministic prose (ASCII only, so chars equal UTF-16 units and bytes). */
function makeText(route: string, req: number, chars: number): string {
	const rand = mulberry32(Number(BigInt.asUintN(32, BigInt(Bun.hash(`${route}#${req}`)))));
	let out = "";
	let sentence = 0;
	while (out.length < chars) {
		const word = WORDS[Math.floor(rand() * WORDS.length)];
		out += out === "" ? word : sentence === 0 ? `. ${word}` : ` ${word}`;
		sentence = (sentence + 1) % 12;
		if (sentence === 0 && rand() < 0.2) out += ".\n\n";
	}
	const text = out.slice(0, chars);
	return chars > 0 ? `${text.slice(0, -1)}.` : text;
}

/** One piece of a streamed assistant message. */
type Piece =
	| { kind: "text"; text: string }
	| { kind: "toolCalls"; calls: Array<{ id: string; name: string; args: string }> };

interface Plan {
	route: string;
	req: number;
	pieces: Piece;
	chunkChars: number;
	deltasPerSec: number;
}

function toolId(route: string, req: number, index: number): string {
	return `call_${Bun.hash(route).toString(36)}_${req}_${index}`;
}

/** The deterministic bash command emitting exactly `bytes` bytes of stdout, varied by `salt`. */
function bashCommand(bytes: number, salt: number): string {
	return (
		`awk -v n=${bytes} -v b=${salt * 1_000_003} 'BEGIN { pad = "${LINE_PAD}"; ` +
		`full = int(n / ${LINE_BYTES}); ` +
		`for (i = 0; i < full; i++) printf "%07d %s\\n", (b + i) % 10000000, pad; ` +
		`printf "%s", substr(pad, 1, n % ${LINE_BYTES}) }'`
	);
}

function textDirectiveFor(
	route: string,
	chars: number,
	chunkChars: number,
	deltasPerSec: number,
): TextDirective {
	return { kind: "text", route, chars, chunkChars, deltasPerSec };
}

function subagentAssignment(directive: TextDirective): string {
	return `Follow the profiling directive below exactly.\n${DIRECTIVE_MARKER} ${JSON.stringify(directive)}`;
}

/** Decide the response for a located request; a string is a configuration error for the caller to surface. */
function plan(position: Position, offered: ToolOffer[]): Plan | string {
	const { directive, req, step } = position;
	const route = directive.route;
	const final = (chars: number): Plan => ({
		route,
		req,
		pieces: { kind: "text", text: makeText(route, req, chars) },
		chunkChars: FINAL_CHUNK_CHARS,
		deltasPerSec: FINAL_DELTAS_PER_SEC,
	});
	const offers = (name: string): boolean => offered.some((tool) => tool.name === name);
	switch (directive.kind) {
		case "idle":
			return {
				route,
				req,
				pieces: { kind: "text", text: AUX_TEXT },
				chunkChars: AUX_TEXT.length,
				deltasPerSec: 0,
			};
		case "text":
			return {
				route,
				req,
				pieces: { kind: "text", text: makeText(route, req, directive.chars) },
				chunkChars: directive.chunkChars,
				deltasPerSec: directive.deltasPerSec,
			};
		case "tool": {
			if (!offers("bash")) return "the request offers no bash tool";
			const issued = directive.parallel
				? step === 0
					? directive.calls
					: 0
				: step < directive.calls
					? 1
					: 0;
			if (issued === 0) return final(directive.finalChars);
			const first = directive.parallel ? 0 : step;
			const calls = [];
			for (let k = 0; k < issued; k++) {
				const index = first + k;
				calls.push({
					id: toolId(route, req, index),
					name: "bash",
					args: JSON.stringify({
						command: bashCommand(directive.outputBytes, index + 1),
						i: "Emitting profiling output",
					}),
				});
			}
			return { route, req, pieces: { kind: "toolCalls", calls }, chunkChars: 0, deltasPerSec: 0 };
		}
		case "subagent": {
			// Steps 1..agents: one `wait` per subagent (task returns immediately and results auto-deliver),
			// so the parent stays busy until the fan-out settles, as a real model would.
			if (step > 0) {
				if (step > directive.agents || !offers("wait")) return final(directive.finalChars);
				const args = JSON.stringify({ i: "Waiting for profiling subagents" });
				return {
					route,
					req,
					pieces: { kind: "toolCalls", calls: [{ id: toolId(route, req, 0), name: "wait", args }] },
					chunkChars: 0,
					deltasPerSec: 0,
				};
			}
			if (!offers("task")) return "the request offers no task tool";
			const tasks = [];
			for (let k = 0; k < directive.agents; k++) {
				tasks.push({
					name: `ProfileAgent${k}`,
					task: subagentAssignment(
						textDirectiveFor(
							`${route}/a${k}`,
							directive.textChars,
							directive.chunkChars,
							directive.deltasPerSec,
						),
					),
					solutionSpace: "one fix: stream the requested text, nothing else",
				});
			}
			const args = JSON.stringify({
				context: "Profiling fan-out. Each task is independent.",
				tasks,
				i: "Spawning profiling subagents",
			});
			return {
				route,
				req,
				pieces: { kind: "toolCalls", calls: [{ id: toolId(route, req, 0), name: "task", args }] },
				chunkChars: 0,
				deltasPerSec: 0,
			};
		}
	}
}

function aux(): Plan {
	return {
		route: "",
		req: 0,
		pieces: { kind: "text", text: AUX_TEXT },
		chunkChars: AUX_TEXT.length,
		deltasPerSec: 0,
	};
}

const encoder = new TextEncoder();

function sse(data: unknown): Uint8Array {
	return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

/** Argument-JSON fragments a tool call streams in: name chunk first, then arguments in a few pieces. */
function argFragments(args: string): string[] {
	const parts = 3;
	const size = Math.max(1, Math.ceil(args.length / parts));
	const out: string[] = [];
	for (let at = 0; at < args.length; at += size) out.push(args.slice(at, at + size));
	return out;
}

/** A few worker threads that analyze request bodies off the thread that paces the streams. */
class ParsePool {
	static readonly SIZE = 3;
	readonly #workers: Worker[] = [];
	readonly #pending = new Map<number, (result: Analysis | string) => void>();
	#next = 0;
	#job = 0;

	constructor() {
		for (let i = 0; i < ParsePool.SIZE; i++) {
			const worker = new Worker(new URL("./parse-worker.ts", import.meta.url).href);
			worker.onmessage = (event: MessageEvent<ParseResult>) => {
				this.#pending.get(event.data.id)?.(event.data.result);
				this.#pending.delete(event.data.id);
			};
			this.#workers.push(worker);
		}
	}

	analyze(body: ArrayBuffer): Promise<Analysis | string> {
		const { promise, resolve } = Promise.withResolvers<Analysis | string>();
		const id = ++this.#job;
		this.#pending.set(id, resolve);
		const job: ParseJob = { id, body };
		this.#workers[this.#next++ % this.#workers.length]!.postMessage(job, [body]);
		return promise;
	}

	close(): void {
		for (const worker of this.#workers) worker.terminate();
	}
}

class SendLog {
	readonly #sink: ReturnType<ReturnType<typeof Bun.file>["writer"]>;
	readonly #timer: ReturnType<typeof setInterval>;
	/** Rows wait here, unserialized, so `record` costs one clock read and one push on the streaming path. */
	#rows: Array<[string, number, number, number, bigint]> = [];

	constructor(path: string) {
		this.#sink = Bun.file(path).writer({ highWaterMark: 1 << 20 });
		this.#timer = setInterval(() => void this.flush(), 100);
	}

	record(route: string, req: number, contentIndex: number, offset: number): void {
		this.#rows.push([route, req, contentIndex, offset, monotonicNs()]);
	}

	async flush(): Promise<void> {
		const rows = this.#rows;
		this.#rows = [];
		for (const [route, req, contentIndex, offset, sendNs] of rows) {
			this.#sink.write(
				`${JSON.stringify({ route, req, contentIndex, offset, sendNs: sendNs.toString() })}\n`,
			);
		}
		await this.#sink.flush();
	}

	async close(): Promise<void> {
		clearInterval(this.#timer);
		await this.flush();
		await this.#sink.end();
	}
}

function respond(request: Analysis, chosen: Plan, log: SendLog): Response {
	const { route, req, pieces } = chosen;
	const id = `chatcmpl-${route === "" ? "aux" : route}-${req}`;
	const base = { id, object: "chat.completion.chunk", created: CREATED, model: request.model };
	const logged = route !== "";
	const source: Bun.DirectUnderlyingSource = {
		type: "direct",
		async pull(controller) {
			const write = async (data: unknown): Promise<void> => {
				controller.write(sse(data));
				await controller.flush();
			};
			const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
				...base,
				choices: [{ index: 0, delta, finish_reason: finish }],
			});
			let completionChars = 0;
			if (pieces.kind === "text") {
				await write(chunk({ role: "assistant", content: "" }));
				const { text } = pieces;
				const step = Math.max(1, chosen.chunkChars);
				const gapNs = chosen.deltasPerSec > 0 ? 1e9 / chosen.deltasPerSec : 0;
				const start = monotonicNs();
				let index = 0;
				for (let at = 0; at < text.length; at += step, index++) {
					if (gapNs > 0) {
						const due = start + BigInt(Math.round(index * gapNs));
						const waitMs = Number(due - monotonicNs()) / 1e6;
						if (waitMs >= 1) await Bun.sleep(waitMs);
					}
					const piece = text.slice(at, at + step);
					const offset = at + piece.length;
					// Encode first, stamp last: the send time is the moment the bytes are handed to the socket.
					const bytes = sse(chunk({ content: piece }));
					if (logged) log.record(route, req, 0, offset);
					controller.write(bytes);
					await controller.flush();
				}
				completionChars = text.length;
				await write(chunk({}, "stop"));
			} else {
				let first = true;
				for (const [index, call] of pieces.calls.entries()) {
					const head = {
						index,
						id: call.id,
						type: "function",
						function: { name: call.name, arguments: "" },
					};
					await write(
						chunk(
							first
								? { role: "assistant", content: null, tool_calls: [head] }
								: { tool_calls: [head] },
						),
					);
					first = false;
					for (const fragment of argFragments(call.args)) {
						await write(chunk({ tool_calls: [{ index, function: { arguments: fragment } }] }));
					}
					completionChars += call.args.length;
				}
				await write(chunk({}, "tool_calls"));
			}
			const promptTokens = Math.ceil(request.bytes / 4);
			const completionTokens = Math.ceil(completionChars / 4);
			await write({
				...base,
				choices: [],
				usage: {
					prompt_tokens: promptTokens,
					completion_tokens: completionTokens,
					total_tokens: promptTokens + completionTokens,
				},
			});
			controller.write(encoder.encode("data: [DONE]\n\n"));
			await controller.flush();
			controller.end();
		},
	};
	// Bun's direct stream type is missing from the ReadableStream constructor overloads.
	const body = new ReadableStream(source as never);
	return new Response(body, {
		headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
	});
}

/** Start the fake model. Resolves once the listener is bound and the send log exists. */
export async function startFakeModel(opts: FakeModelOptions): Promise<FakeModel> {
	await Bun.write(opts.sendLog, "");
	const log = new SendLog(opts.sendLog);
	const parser = new ParsePool();
	const server = Bun.serve({
		port: opts.port ?? 0,
		hostname: opts.hostname ?? "127.0.0.1",
		idleTimeout: 0,
		async fetch(req) {
			const url = new URL(req.url);
			if (req.method === "GET" && url.pathname.endsWith("/models")) {
				return Response.json({ object: "list", data: [{ id: "profile-1", object: "model" }] });
			}
			if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
				return new Response("not found", { status: 404 });
			}
			const parsed = await parser.analyze(await req.arrayBuffer());
			if (typeof parsed === "string")
				return Response.json({ error: { message: parsed } }, { status: 400 });
			if (parsed.position === undefined) return respond(parsed, aux(), log);
			const chosen = plan(parsed.position, parsed.tools);
			if (typeof chosen === "string") {
				return Response.json({ error: { message: `fake model: ${chosen}` } }, { status: 400 });
			}
			return respond(parsed, chosen, log);
		},
	});
	return {
		url: `http://${server.hostname}:${server.port}`,
		flush: () => log.flush(),
		async close() {
			await server.stop(true);
			parser.close();
			await log.close();
		},
	};
}
