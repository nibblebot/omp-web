/**
 * FPS-03 regression: a log-store repair applied at boot (a torn tail truncated
 * to the last newline) is recorded in the fleet event log, so operators see
 * that drift was healed instead of it happening silently.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FleetLogStore } from "../log-store";
import { cleanupTempDirs, fleetPaths, pinSettingsInMemory, startTestFleet } from "./server.testkit";

afterAll(cleanupTempDirs);

// Same pin as server-routes.test.ts: keep the process-global Settings
// singleton in memory so these tests never open the real ~/.omp auth DB.
await pinSettingsInMemory();

describe("fleet boot log repair", () => {
	test("a torn log tail repaired at boot is recorded in the event log", async () => {
		const { statePath, configPath } = fleetPaths();
		const logsRoot = join(dirname(statePath), "logs");
		const seed = FleetLogStore.load(logsRoot);
		seed.ingest("ws-boot", "sess-boot", "sess-boot.jsonl", {
			offset: 0,
			generation: 1,
			data: Buffer.from('{"seq":1}\n', "utf8").toString("base64"),
			eof: false,
		});
		appendFileSync(join(logsRoot, "ws-boot", "sess-boot", "sess-boot.jsonl"), '{"seq":2,"pa');

		const server = await startTestFleet(
			{ statePath, configPath },
			{},
			{ settings: { registry: async () => [] } },
		);
		try {
			const repaired = server.eventLog
				.list()
				.filter((e) => e.source === "server" && e.message.startsWith("log store repaired"));
			expect(repaired).toHaveLength(1);
			expect(repaired[0]?.level).toBe("warn");
		} finally {
			await server.close();
		}
	});
});
