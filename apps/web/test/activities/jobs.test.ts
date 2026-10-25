import { describe, expect, test } from "bun:test";
import type { JobDto } from "#lib/wire/protocol";
import { flatJobRow, visibleJobRows } from "../../activities/jobs";
import type { ActivityJobRow } from "../../activities/summary";

const row = (
	id: string,
	status: JobDto["status"],
	place: Partial<Pick<ActivityJobRow, "depth" | "rails" | "last" | "parent">> = {},
): ActivityJobRow => ({
	kind: "job",
	depth: 0,
	rails: [],
	last: true,
	parent: false,
	...place,
	job: { id, type: "bash", status, label: id, startTime: 1, own: true },
});

describe("the Jobs section's filter", () => {
	const rows = [row("run", "running"), row("done", "completed"), row("bad", "failed")];

	test("All lists every job, running and settled, in poll order", () => {
		expect(visibleJobRows(rows, "all", new Set()).map((r) => r.job.id)).toEqual([
			"run",
			"done",
			"bad",
		]);
	});

	test("Running lists only running jobs", () => {
		expect(visibleJobRows(rows, "running", new Set()).map((r) => r.job.id)).toEqual(["run"]);
	});

	test("Running keeps an open job that has settled", () => {
		expect(visibleJobRows(rows, "running", new Set(["bad"])).map((r) => r.job.id)).toEqual([
			"run",
			"bad",
		]);
	});

	test("Running with nothing running is empty", () => {
		expect(visibleJobRows([row("done", "completed")], "running", new Set())).toEqual([]);
	});
});

describe("a job row in the flat Jobs list", () => {
	test("a job nested under a subagent is listed at the top, without rails", () => {
		const nested = row("nested", "running", {
			depth: 2,
			rails: [true, false],
			last: false,
			parent: true,
		});
		expect(flatJobRow(nested)).toMatchObject({
			depth: 0,
			rails: [],
			last: true,
			parent: false,
			job: { id: "nested" },
		});
	});

	test("a top-level row is kept as it is", () => {
		const top = row("top", "running");
		expect(flatJobRow(top)).toBe(top);
	});
});
