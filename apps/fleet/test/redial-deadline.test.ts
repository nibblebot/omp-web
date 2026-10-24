/**
 * Runtime redial deadline (FLC-01): a ready session that loses its pair and
 * is shown reconnecting must not stay reconnecting forever. The boot path
 * already arms a deadline; this pins the same deadline for runtime pair loss.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "#lib/testkit/temp-dir.testkit";
import { startFleet, type FleetServer } from "../server";
import { enrollSessionCredential } from "../session-credential";
import { type CallbackDaemon, startCallbackDaemon } from "./callback-daemon.testkit";
import { FAKE_CWD, cleanupTempDirs, stopSpawnedRows, waitFor } from "./edge.testkit";
import { hermeticStatsConfig } from "./server.testkit";

afterAll(cleanupTempDirs);

const PAIR_LOSS_GRACE_MS = 200;
const REDIAL_GRACE_MS = 1_000;

describe("runtime redial deadline", () => {
	const tmp = tempDir("omp-web-redial-deadline-");
	const statePath = join(tmp, "state.json");
	const configPath = join(tmp, "config.json");
	const daemons: CallbackDaemon[] = [];
	let server: FleetServer;

	// Same dev-runner hermeticity as the pair-loss suite: a shell that ran
	// `bun run dev` carries OMP_FLEET_LOCAL_TEMPLATE, which would replace the
	// sleep-loop `local` template with a real session launch.
	let savedLocalTemplate: string | undefined;
	beforeAll(async () => {
		savedLocalTemplate = process.env.OMP_FLEET_LOCAL_TEMPLATE;
		delete process.env.OMP_FLEET_LOCAL_TEMPLATE;
		mkdirSync(FAKE_CWD, { recursive: true });
		writeFileSync(
			configPath,
			JSON.stringify({
				templates: {
					local: { command: ": {fleet}; while kill -0 $PPID 2>/dev/null; do sleep 0.05; done" },
				},
				defaultTemplate: "local",
			}),
		);
		server = await startFleet({
			port: 0,
			statePath,
			configPath,
			statsConfig: hermeticStatsConfig(statePath),
			pairLossGraceMs: PAIR_LOSS_GRACE_MS,
			redialGraceMs: REDIAL_GRACE_MS,
		});
	});

	afterAll(async () => {
		for (const daemon of daemons) daemon.stop();
		try {
			await stopSpawnedRows(server);
		} finally {
			await server.close();
		}
		if (savedLocalTemplate !== undefined) process.env.OMP_FLEET_LOCAL_TEMPLATE = savedLocalTemplate;
	});

	test("a runtime-reconnecting session that never re-pairs becomes asleep after the redial grace", async () => {
		const entry = await server.lifecycle.spawnHost({
			cwd: FAKE_CWD,
			name: "redial-outage",
			template: "local",
		});
		const { generation, credential } = enrollSessionCredential(
			server.transport,
			server.registry,
			entry.daemonId,
		);
		// A redial delay longer than the test window: the pair stays down.
		const daemon = startCallbackDaemon({
			url: `http://127.0.0.1:${server.port}`,
			workspaceId: entry.daemonId,
			generation,
			token: credential,
			redialMinMs: 60_000,
			redialMaxMs: 60_000,
		});
		daemons.push(daemon);
		await daemon.waitConnected(10_000);
		await waitFor(
			() => (server.registry.get(entry.daemonId)?.status === "ready" ? true : null),
			5000,
			"redial-outage ready",
		);

		daemon.dropLegs();
		await waitFor(
			() => (server.registry.get(entry.daemonId)?.status === "reconnecting" ? true : null),
			PAIR_LOSS_GRACE_MS + 3000,
			"reconnecting after pair-loss grace",
		);
		await waitFor(
			() => (server.registry.get(entry.daemonId)?.status === "asleep" ? true : null),
			REDIAL_GRACE_MS + 3000,
			"asleep after redial grace",
		);
		expect(server.transport.pairStatus(entry.daemonId).paired).toBe(false);
	}, 20_000);
});
