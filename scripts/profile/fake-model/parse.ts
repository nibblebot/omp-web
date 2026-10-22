/**
 * Request parsing for the fake model: JSON.parse of the body plus locating the
 * profiling directive and the conversation position. Pure functions of the
 * request, kept apart from the server so a worker thread can run them (see
 * parse-worker.ts): an S3 conversation reaches tens of megabytes of tool
 * results, and parsing that on the thread that paces the streams delayed every
 * delta sent meanwhile.
 */
import { type Directive, parseDirective } from "./directives";

export interface ToolOffer {
	name: string;
}

export interface ChatRequest {
	model: string;
	messages: unknown[];
	tools: ToolOffer[];
	/** Serialized request size, for the usage figure. */
	bytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRequest(raw: string): ChatRequest | string {
	let body: unknown;
	try {
		body = JSON.parse(raw);
	} catch {
		return "request body is not JSON";
	}
	if (!isRecord(body) || !Array.isArray(body.messages)) return "request body has no messages array";
	const tools: ToolOffer[] = [];
	if (Array.isArray(body.tools)) {
		for (const tool of body.tools) {
			if (isRecord(tool) && isRecord(tool.function) && typeof tool.function.name === "string") {
				tools.push({ name: tool.function.name });
			}
		}
	}
	return {
		model: typeof body.model === "string" ? body.model : "fake",
		messages: body.messages,
		tools,
		bytes: raw.length,
	};
}

function messageText(message: Record<string, unknown>): string {
	const { content } = message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const part of content) {
		if (isRecord(part) && typeof part.text === "string") text += `${part.text}\n`;
	}
	return text;
}

export interface Position {
	directive: Directive;
	/** Assistant messages already in the conversation (the log's `req`). */
	req: number;
	/** Assistant messages after the directive message (the turn step). */
	step: number;
}

/** Locate the directive-bearing user message and the conversation position, or `undefined` for aux requests. */
export function locate(messages: unknown[]): Position | undefined {
	let req = 0;
	let found: { directive: Directive; at: number } | undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!isRecord(message)) continue;
		if (message.role === "user" && found === undefined) {
			const directive = parseDirective(messageText(message));
			if (directive !== undefined) found = { directive, at: i };
		}
	}
	if (found === undefined) return undefined;
	let step = 0;
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (!isRecord(message) || message.role !== "assistant") continue;
		req++;
		if (i > found.at) step++;
	}
	return { directive: found.directive, req, step };
}

/** What the server needs from a request; small enough to cross a worker boundary cheaply. */
export interface Analysis {
	model: string;
	tools: ToolOffer[];
	/** Serialized request size, for the usage figure. */
	bytes: number;
	/** Undefined for requests without a directive (SDK side requests). */
	position: Position | undefined;
}

/** Parse a raw request body and locate its directive; a string is an error message for a 400. */
export function analyze(raw: string): Analysis | string {
	const parsed = parseRequest(raw);
	if (typeof parsed === "string") return parsed;
	return {
		model: parsed.model,
		tools: parsed.tools,
		bytes: parsed.bytes,
		position: locate(parsed.messages),
	};
}
