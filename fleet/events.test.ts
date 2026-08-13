/**
 * FleetEventLog tests: ring cap, list ordering/copying, and the onEntry
 * mirror.
 */

import { describe, expect, test } from "bun:test";
import { FleetEventLog } from "./events";

describe("FleetEventLog", () => {
	test("add appends entries in order; list returns a copy, oldest first", () => {
		const log = new FleetEventLog(10);
		log.add("info", "connector", "connecting", "d1");
		log.add("warn", "supervisor", "exit code=1", "d2");
		log.add("error", "server", "request failed");
		const list = log.list();
		expect(list).toHaveLength(3);
		expect(list.map((entry) => entry.message)).toEqual(["connecting", "exit code=1", "request failed"]);
		expect(list[0]).toMatchObject({ level: "info", source: "connector", daemonId: "d1" });
		expect(list[2]?.level).toBe("error");
		expect(list[2]?.daemonId).toBeUndefined();
		// The returned array is a copy: mutating it must not affect the ring.
		list.shift();
		expect(log.list()).toHaveLength(3);
	});

	test("the ring is capped: the oldest entries fall off past the cap", () => {
		const log = new FleetEventLog(3);
		for (let i = 0; i < 10; i++) log.add("info", "server", `event ${i}`, `d${i}`);
		const list = log.list();
		expect(list).toHaveLength(3);
		expect(list.map((entry) => entry.message)).toEqual(["event 7", "event 8", "event 9"]);
		expect(list.map((entry) => entry.daemonId)).toEqual(["d7", "d8", "d9"]);
	});

	test("onEntry mirrors every added entry as it lands", () => {
		const log = new FleetEventLog(10);
		const seen: string[] = [];
		log.onEntry = (entry) => seen.push(`${entry.level}:${entry.message}`);
		log.add("info", "connector", "ready", "d9");
		log.add("error", "server", "boom");
		expect(seen).toEqual(["info:ready", "error:boom"]);
	});
});
