import { describe, expect, test } from "bun:test";
import { isActiveSubagent, type SubagentInfo } from "./state";

function sub(status: string): SubagentInfo {
	return { id: "s1", index: 0, agent: "task", status, lastUpdate: 0 };
}

describe("isActiveSubagent", () => {
	test("in-flight statuses are active", () => {
		expect(isActiveSubagent(sub("pending"))).toBe(true);
		expect(isActiveSubagent(sub("started"))).toBe(true);
		expect(isActiveSubagent(sub("running"))).toBe(true);
	});

	test("terminal statuses are not active", () => {
		expect(isActiveSubagent(sub("completed"))).toBe(false);
		expect(isActiveSubagent(sub("failed"))).toBe(false);
		expect(isActiveSubagent(sub("aborted"))).toBe(false);
	});

	test("unknown or empty statuses are not active", () => {
		expect(isActiveSubagent(sub("parked"))).toBe(false);
		expect(isActiveSubagent(sub("idle"))).toBe(false);
		expect(isActiveSubagent(sub(""))).toBe(false);
	});
});
