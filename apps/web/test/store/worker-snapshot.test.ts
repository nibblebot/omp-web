/**
 * The first roster read after a spawn can carry a live sample taken milliseconds in (0 tokens, 45 ms).
 * Once the worker settles, that sample must not outlive it: the row's own usage is the truth.
 */
import { describe, expect, test } from "bun:test";
import { normalizeWorkerSnapshot, type WorkersState } from "../../store/subagents";

const EMPTY: WorkersState = { records: {}, order: [] } as unknown as WorkersState;
const SESSION = "s1";

const sample = {
	id: "ImageReader",
	status: "running",
	tokens: 0,
	requests: 0,
	cost: 0,
	durationMs: 45,
};

function running(): WorkersState {
	return normalizeWorkerSnapshot(EMPTY, SESSION, [
		{ id: "ImageReader", status: "running", sessionFile: "/s/ImageReader.jsonl", progress: sample },
	]);
}

function recordOf(workers: WorkersState) {
	return Object.values(workers.records)[0];
}

describe("normalizeWorkerSnapshot", () => {
	test("every row is listed once in `order`, new or already known", () => {
		const first = running();
		expect(first.order).toEqual(Object.keys(first.records));
		expect(first.order).toHaveLength(1);
		const again = normalizeWorkerSnapshot(first, SESSION, [
			{ id: "ImageReader", status: "parked" },
		]);
		expect(again.order).toEqual(first.order);
	});

	test("a running worker keeps its progress sample between reads that omit it", () => {
		const next = normalizeWorkerSnapshot(running(), SESSION, [
			{ id: "ImageReader", status: "running" },
		]);
		expect(recordOf(next).progress).toEqual(sample);
		expect(recordOf(next).usage).toMatchObject({ tokens: 0 });
	});

	test("a settled worker drops the stale sample and takes the row's usage", () => {
		const usage = { tokens: 71_954, requests: 4, cost: 0.1969 };
		const next = normalizeWorkerSnapshot(running(), SESSION, [
			{ id: "ImageReader", status: "parked", sessionFile: "/s/ImageReader.jsonl", usage },
		]);
		expect(recordOf(next).progress).toBeUndefined();
		expect(recordOf(next).usage).toMatchObject(usage);
	});

	test("a settled worker with no reported usage is unknown, not the stale zero", () => {
		const next = normalizeWorkerSnapshot(running(), SESSION, [
			{ id: "ImageReader", status: "completed" },
		]);
		expect(recordOf(next).progress).toBeUndefined();
		expect(recordOf(next).usage).toBeUndefined();
	});
});
