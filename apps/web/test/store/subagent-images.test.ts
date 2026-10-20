/**
 * 40dg: the agent pane reads a subagent transcript raw, so its images arrive as `blob:sha256:` refs. The
 * transcript store resolves them lazily by hash and patches the built items in place.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SubagentImageResult } from "#lib/wire/protocol";
import * as transport from "../../store/transport";

interface Call {
	method: string;
	args: unknown;
}
const calls: Call[] = [];
let handler: (method: string, args: unknown) => Promise<unknown> = async () => undefined;
const originalTransport = { ...transport };
mock.module("../../store/transport", () => ({
	...originalTransport,
	call: (method: string, args: unknown) => {
		calls.push({ method, args });
		return handler(method, args);
	},
}));

afterAll(() => {
	// mock.restore() leaves module mocks installed; reinstall the real exports for later files.
	mock.module("../../store/transport", () => originalTransport);
});

// Dynamic imports: the transport mock must be registered before the store module binds to it.
const { subagentTranscript, syncSubagentTranscript } = await import("../../store/subagents");
const { setState } = await import("../../state");

// Hashes are content addresses shared across transcripts; each test gets its own so the resolved-image cache never carries over.
let HASH_A = "";
let HASH_B = "";
let HASH_C = "";
const ref = (hash: string) => `blob:sha256:${hash}`;

const settle = async () => {
	for (let i = 0; i < 30; i++) await Promise.resolve();
};

function userWithImages(...hashes: string[]) {
	return {
		role: "user",
		content: [
			{ type: "text", text: "look" },
			...hashes.map((hash) => ({ type: "image", data: ref(hash), mimeType: "image/png" })),
		],
	};
}

function pageOf(messages: unknown[], nextByte: number) {
	const entries = messages.map((message, index) => ({
		type: "message",
		id: `m${nextByte}-${index}`,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message,
	}));
	return {
		sessionFile: "/s/a.jsonl",
		fromByte: 0,
		nextByte,
		reset: false,
		hasMore: false,
		entries,
		messages,
	};
}

interface Deferred {
	hash: string;
	resolve: (answer: SubagentImageResult) => void;
	reject: (error: Error) => void;
}

/** Transcript pages are served in order; every image call parks until the test answers it. */
function serve(pages: unknown[]): Deferred[] {
	const parked: Deferred[] = [];
	let next = 0;
	handler = async (method, args) => {
		if (method === "getSubagentMessages") return pages[Math.min(next++, pages.length - 1)];
		if (method === "getSubagentImage") {
			const [{ hash }] = args as [{ hash: string }];
			return new Promise<SubagentImageResult>((resolve, reject) =>
				parked.push({ hash, resolve, reject }),
			);
		}
		return undefined;
	};
	return parked;
}

const imageCalls = () => calls.filter((call) => call.method === "getSubagentImage");

// One session id per test keeps transcript slots (module state) apart.
let agent = "";
let counter = 0;
beforeEach(() => {
	calls.length = 0;
	counter += 1;
	const hex = (digit: string) => `${digit}${counter.toString(16)}`.padEnd(64, digit);
	HASH_A = hex("a");
	HASH_B = hex("b");
	HASH_C = hex("c");
	agent = `agent-${counter}`;
	setState("currentSessionId", `session-${counter}`);
});

/** Bump the agent's lastUpdate so syncSubagentTranscript reads the next page. */
function bump(lastUpdate: number): void {
	setState(
		"subagents",
		new Map([[agent, { id: agent, index: 0, agent: "task", status: "completed", lastUpdate }]]),
	);
	syncSubagentTranscript(agent);
}

describe("subagent transcript images", () => {
	test("patches the built item in place when the bytes land", async () => {
		const parked = serve([pageOf([userWithImages(HASH_A)], 100)]);
		syncSubagentTranscript(agent);
		await settle();
		const view = subagentTranscript(agent);
		const item = view.items[0] as Extract<(typeof view.items)[number], { kind: "user" }>;
		const images = item.images!;
		const image = images[0];
		expect(image.data).toBe(ref(HASH_A));
		expect(imageCalls().map((call) => call.args)).toEqual([[{ subagentId: agent, hash: HASH_A }]]);

		parked[0].resolve({ status: "ok", data: "QUJD", mimeType: "image/webp" });
		await settle();
		expect(view.items[0]).toBe(item);
		expect(item.images).toBe(images);
		expect(item.images![0]).toBe(image);
		expect(image).toMatchObject({ data: "QUJD", mimeType: "image/webp" });
	});

	test("a sniffed octet-stream type keeps the transcript block's declared type", async () => {
		const parked = serve([pageOf([userWithImages(HASH_A)], 100)]);
		syncSubagentTranscript(agent);
		await settle();
		parked[0].resolve({ status: "ok", data: "QUJD", mimeType: "application/octet-stream" });
		await settle();
		expect(subagentTranscript(agent).items[0]).toMatchObject({
			images: [{ data: "QUJD", mimeType: "image/png" }],
		});
	});

	test("a hash resolved once patches later pages without asking again, and one hash is asked once", async () => {
		const parked = serve([
			pageOf([userWithImages(HASH_A, HASH_A)], 100),
			pageOf([userWithImages(HASH_A)], 200),
		]);
		syncSubagentTranscript(agent);
		await settle();
		expect(imageCalls()).toHaveLength(1);
		parked[0].resolve({ status: "ok", data: "QUJD", mimeType: "image/png" });
		await settle();

		bump(5);
		await settle();
		const items = subagentTranscript(agent).items;
		expect(items).toHaveLength(2);
		expect(items[1]).toMatchObject({ images: [{ data: "QUJD" }] });
		expect(imageCalls()).toHaveLength(1);
	});

	test("a too-large, missing or failed hash stays a ref and is never asked again", async () => {
		const parked = serve([
			pageOf([userWithImages(HASH_A, HASH_B, HASH_C)], 100),
			pageOf([userWithImages(HASH_A, HASH_B, HASH_C)], 200),
			pageOf([userWithImages(HASH_A, HASH_B, HASH_C)], 300),
		]);
		syncSubagentTranscript(agent);
		await settle();
		expect(imageCalls()).toHaveLength(3);
		const byHash = new Map(parked.map((entry) => [entry.hash, entry]));
		byHash.get(HASH_A)!.resolve({ status: "too_large", bytes: 5_000_000 });
		byHash.get(HASH_B)!.resolve({ status: "missing" });
		byHash.get(HASH_C)!.reject(new Error("socket closed"));
		await settle();

		bump(5);
		await settle();
		bump(6);
		await settle();
		expect(imageCalls()).toHaveLength(3);
		const [first, second] = subagentTranscript(agent).items;
		for (const item of [first, second]) {
			const { images } = item as { images: Array<{ data: string }> };
			expect(images.map((image) => image.data)).toEqual([ref(HASH_A), ref(HASH_B), ref(HASH_C)]);
		}
	});

	test("fetches at most three images at once", async () => {
		const hashes = ["1", "2", "3", "4", "5"].map((digit) =>
			`${digit}${counter.toString(16)}`.padEnd(64, digit),
		);
		const parked = serve([pageOf([userWithImages(...hashes)], 100)]);
		syncSubagentTranscript(agent);
		await settle();
		expect(imageCalls()).toHaveLength(3);
		parked[0].resolve({ status: "ok", data: "QQ==", mimeType: "image/png" });
		await settle();
		expect(imageCalls()).toHaveLength(4);
		parked[1].resolve({ status: "ok", data: "QQ==", mimeType: "image/png" });
		await settle();
		expect(imageCalls()).toHaveLength(5);
		for (const entry of parked.slice(2))
			entry.resolve({ status: "ok", data: "QQ==", mimeType: "image/png" });
		await settle();
		const { images } = subagentTranscript(agent).items[0] as { images: Array<{ data: string }> };
		expect(images.map((image) => image.data)).toEqual(["QQ==", "QQ==", "QQ==", "QQ==", "QQ=="]);
	});

	test("a tool result landing on a later page re-patches the replaced images from the cache", async () => {
		const parked = serve([
			pageOf(
				[
					userWithImages(HASH_A),
					{
						role: "assistant",
						content: [{ type: "toolCall", id: "call-1", name: "browser", arguments: {} }],
					},
				],
				100,
			),
			pageOf(
				[
					{
						role: "toolResult",
						toolCallId: "call-1",
						toolName: "browser",
						content: [{ type: "image", data: ref(HASH_A), mimeType: "image/png" }],
					},
				],
				200,
			),
		]);
		syncSubagentTranscript(agent);
		await settle();
		parked[0].resolve({ status: "ok", data: "QUJD", mimeType: "image/png" });
		await settle();

		bump(5);
		await settle();
		const tool = subagentTranscript(agent).items.find((item) => item.kind === "tool");
		expect(tool).toMatchObject({ images: [{ data: "QUJD" }] });
		expect(imageCalls()).toHaveLength(1);
	});
});
