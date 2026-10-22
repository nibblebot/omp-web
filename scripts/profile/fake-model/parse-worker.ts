/**
 * Worker entry for the fake model's request analysis (see parse.ts). Receives a
 * transferred request body, answers with the small `Analysis`.
 */
import { type Analysis, analyze } from "./parse";

export interface ParseJob {
	id: number;
	body: ArrayBuffer;
}

export interface ParseResult {
	id: number;
	result: Analysis | string;
}

declare const self: Worker;

const decoder = new TextDecoder();

self.onmessage = (event: MessageEvent<ParseJob>) => {
	const { id, body } = event.data;
	const result: ParseResult = { id, result: analyze(decoder.decode(body)) };
	self.postMessage(result);
};
