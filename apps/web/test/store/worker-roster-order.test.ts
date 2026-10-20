/**
 * After a reload the agent surfaces (header "N subagents" button, fanout rows,
 * agent dock) read the session's workers through `state.workers.order`. A
 * snapshot that fills `records` but not `order` leaves them all empty.
 */
import { describe, expect, test } from "bun:test";
import { normalizeWorkerSnapshot, workerKey, type WorkersState } from "../../store/subagents";

const EMPTY: WorkersState = { records: {}, order: [] } as unknown as WorkersState;

describe("worker roster order", () => {
	test("a snapshot lists every worker it discovers, once, in snapshot order", () => {
		const rows = [
			{ id: "ShotTaker", status: "parked" },
			{ id: "ImageReader", status: "parked" },
		];
		const first = normalizeWorkerSnapshot(EMPTY, "d6", rows);
		expect(first.order).toEqual([workerKey("d6", "ShotTaker"), workerKey("d6", "ImageReader")]);

		const again = normalizeWorkerSnapshot(first, "d6", rows);
		expect(again.order).toEqual(first.order);
	});
});
