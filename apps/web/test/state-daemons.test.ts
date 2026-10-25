import { describe, expect, test } from "bun:test";
import { isLiveDaemon } from "../state";
import { formatUptime } from "../text/uptime";
import type { DaemonInfo } from "#lib/wire/protocol";

function daemon(state: string): DaemonInfo {
	return {
		name: "d1",
		id: "id1",
		projectDir: "/tmp/proj",
		state,
		createdAt: 0,
		startedAt: 0,
		restartCount: 0,
		persist: false,
		detached: false,
	};
}

describe("isLiveDaemon", () => {
	test("supervised states are live", () => {
		expect(isLiveDaemon(daemon("starting"))).toBe(true);
		expect(isLiveDaemon(daemon("running"))).toBe(true);
		expect(isLiveDaemon(daemon("ready"))).toBe(true);
		expect(isLiveDaemon(daemon("restarting"))).toBe(true);
		expect(isLiveDaemon(daemon("stopping"))).toBe(true);
	});

	test("terminal states are not live", () => {
		expect(isLiveDaemon(daemon("exited"))).toBe(false);
		expect(isLiveDaemon(daemon("failed"))).toBe(false);
	});

	test("unknown or empty states are not live", () => {
		expect(isLiveDaemon(daemon("unknown"))).toBe(false);
		expect(isLiveDaemon(daemon(""))).toBe(false);
	});
});

describe("formatUptime", () => {
	test("sub-minute uptime", () => {
		expect(formatUptime(0)).toBe("0s");
		expect(formatUptime(45_000)).toBe("45s");
	});

	test("minute and second uptime", () => {
		expect(formatUptime(90_000)).toBe("1m 30s");
	});

	test("hour and minute uptime", () => {
		expect(formatUptime(3_661_000)).toBe("1h 1m");
	});
});
