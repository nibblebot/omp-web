/**
 * One crash policy for every runtime kind (kata 0331): the lifecycle owner's
 * `#restartOrGiveUp` restarts a host session and a provider clone identically,
 * so every case below runs against BOTH rigs through one table:
 *
 *   - crash after pair-up: the dead generation's credential is revoked first,
 *     then the runtime restarts with a fresh credential at generation + 1;
 *   - a crash loop past the cap gives up as status "error" + lifecycleStage
 *     "failed", both carrying the reason (the same roster shape for each kind);
 *   - a pair that holds refills the cap, so it bounds crash loops, not lifetime;
 *   - exit 77 and 78 never restart (a host child's exit code, a clone provider's
 *     reported `exitCode`): the row goes asleep with the reason, startable again;
 *   - an explicit stop cancels a restart that is backing off.
 *
 * The host rig runs a real fake child (sh) under the in-process host provider
 * and a real DaemonTransportRegistry; the clone rig is a real fleet with a
 * scripted fake provider (clone-crash.testkit.ts). Both pair a real callback
 * daemon with the credential of the current launch.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import type { FleetConfig } from "../config";
import { DaemonTransportRegistry, type CallbackSocketData } from "../daemon-transport";
import { Registry, type RegistryEntry } from "../registry";
import type { CloneRuntimePolicy } from "../workspace-lifecycle";
import { type CallbackDaemon, startCallbackDaemon } from "./callback-daemon.testkit";
import {
	FAST_CLONE_RUNTIME,
	bootCloneCrashFixture,
	teardownCloneCrashFixture,
	waitForCloneRoster,
} from "./clone-crash.testkit";
import { makeHostLifecycle } from "./host-lifecycle.testkit";
import { pinSettingsInMemory, postJson, waitFor } from "./server.testkit";

afterAll(cleanupTempDirs);

await pinSettingsInMemory();

/** One launch of the runtime: its generation and the credential handed to it. */
interface Launch {
	generation: number;
	token: string;
}

/** The kind-specific half of a test: everything else runs through this one interface. */
interface Rig {
	entry(): RegistryEntry;
	/** Pair a real callback daemon with the CURRENT launch's credential and wait for the roster to see it. */
	pairUp(): Promise<CallbackDaemon>;
	/** The runtime dies after its pair came up; `exitCode` is what its owner observes (the child's, or the provider's report). */
	crash(daemon: CallbackDaemon, exitCode?: number): Promise<void>;
	/** Every replacement runtime from now on is dead on arrival. */
	poisonReplacements(): void;
	launches(): Launch[];
	/** Explicit stop through the kind's own entry point. */
	stop(): Promise<void>;
	/** Explicit start (the operator's retry). */
	start(): Promise<void>;
	teardown(): Promise<void>;
}

const REASON = (code: number): string => `refusing (exit ${code})`;

async function hostRig(runtime: Partial<CloneRuntimePolicy>): Promise<Rig> {
	const dir = tempDir("restart-parity-host-");
	const payloadFile = join(dir, "payload.txt");
	const crashFile = join(dir, "crash");
	const poisonFile = join(dir, "poison");
	const script = join(dir, "child.sh");
	writeFileSync(
		script,
		[
			"#!/bin/sh",
			'trap "exit 0" TERM INT',
			`{ cat; echo; } >> '${payloadFile}'`,
			`if [ -e '${poisonFile}' ]; then exit 1; fi`,
			// The crash flag carries the exit code; 77/78 log a reason like the real session does.
			`while :; do if [ -e '${crashFile}' ]; then code=$(cat '${crashFile}'); rm -f '${crashFile}'; if [ "$code" = 77 ] || [ "$code" = 78 ]; then echo "omp-session: refusing (exit $code)" >&2; fi; exit "$code"; fi; sleep 0.05; done`,
		].join("\n") + "\n",
	);
	const config: FleetConfig = {
		templates: { test: { command: `sh ${script} {fleet} {resume}` } },
		defaultTemplate: "test",
		workspaceDir: "/tmp/fleet-test-ws",
		bind: "127.0.0.1",
	};
	const statePath = join(tempDir("restart-parity-state-"), "state.json");
	const registry = new Registry(statePath);
	await registry.load();
	const transport = new DaemonTransportRegistry();
	const server: Server<CallbackSocketData> = Bun.serve<CallbackSocketData>({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 255,
		fetch: async (req, srv) => {
			const handled = await transport.handleFetch(req, srv);
			return handled === null ? new Response("not found", { status: 404 }) : handled;
		},
		websocket: transport.websocket,
	});
	const base = `http://127.0.0.1:${server.port}`;
	const { lifecycle } = makeHostLifecycle({
		registry,
		config,
		transport,
		statePath,
		callbackUrl: () => `${base}/callback`,
		runtime: { ...FAST_CLONE_RUNTIME, ...runtime },
	});
	const daemons: CallbackDaemon[] = [];
	const spawned = await lifecycle.spawnHost({ cwd: dir });
	const daemonId = spawned.daemonId;
	const launches = (): Launch[] => {
		if (!existsSync(payloadFile)) return [];
		return readFileSync(payloadFile, "utf8")
			.split("\n")
			.slice(0, -1)
			.map((line) => {
				const payload = JSON.parse(line) as { callback: { generation: number; token: string } };
				return { generation: payload.callback.generation, token: payload.callback.token };
			});
	};
	return {
		entry: () => registry.get(daemonId)!,
		async pairUp() {
			await waitFor(() => launches().length > 0, 5_000, "launch payload");
			const current = launches().at(-1)!;
			const daemon = startCallbackDaemon({
				url: base,
				workspaceId: daemonId,
				generation: current.generation,
				token: current.token,
			});
			daemons.push(daemon);
			await daemon.waitConnected(5_000);
			return daemon;
		},
		async crash(daemon, exitCode = 1) {
			writeFileSync(crashFile, String(exitCode));
			await daemon.stop();
		},
		poisonReplacements: () => writeFileSync(poisonFile, "1"),
		launches,
		stop: () => lifecycle.stop(daemonId),
		start: () => lifecycle.start(daemonId),
		async teardown() {
			for (const daemon of daemons) await daemon.stop().catch(() => undefined);
			await lifecycle.stop(daemonId);
			lifecycle.close();
			transport.close();
			await server.stop(true);
		},
	};
}

async function cloneRig(runtime: Partial<CloneRuntimePolicy>): Promise<Rig> {
	const fx = await bootCloneCrashFixture(runtime);
	// The handoff file is rewritten before the provider logs the ensure, so each
	// generation's token is taken from the handoff that names that generation.
	const seenTokens = new Map<number, string>();
	const record = (): void => {
		const current = fx.currentHandoff();
		if (!seenTokens.has(current.generation)) seenTokens.set(current.generation, current.token);
	};
	const launches = (): Launch[] => {
		record();
		return fx.ensureGenerations().map((generation) => ({
			generation,
			token: seenTokens.get(generation) ?? "",
		}));
	};
	record();
	return {
		entry: () => fx.server.registry.get(fx.daemonId)!,
		async pairUp() {
			record();
			const daemon = await fx.pairUp();
			await waitForCloneRoster(
				fx,
				() => fx.server.registry.get(fx.daemonId)?.lifecycleStage === "ready",
				5_000,
				"pair-up ready",
			);
			return daemon;
		},
		async crash(daemon, exitCode) {
			await fx.kill(
				daemon,
				exitCode === undefined ? undefined : { exitCode, detail: REASON(exitCode) },
			);
		},
		poisonReplacements: () => writeFileSync(join(fx.stateDir, "die-on-ensure"), "1"),
		launches,
		stop: async () => {
			const response = await postJson(fx.server.port, "/ctl/stop", { selector: fx.daemonId });
			expect(response.status).toBe(200);
		},
		start: async () => {
			rmSync(join(fx.stateDir, "dead"), { force: true });
			const response = await postJson(fx.server.port, "/ctl/start", { daemonId: fx.daemonId });
			expect(response.status).toBe(200);
		},
		teardown: () => teardownCloneCrashFixture(fx),
	};
}

const KINDS = [
	["host", hostRig],
	["clone", cloneRig],
] as const;

const teardowns: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const teardown of teardowns.splice(0)) await teardown();
});

async function boot(
	make: (runtime: Partial<CloneRuntimePolicy>) => Promise<Rig>,
	runtime: Partial<CloneRuntimePolicy> = {},
): Promise<Rig> {
	const rig = await make(runtime);
	teardowns.push(() => rig.teardown());
	return rig;
}

describe.each(KINDS)("one crash policy: %s runtime", (_kind, make) => {
	test("a crash after pair-up revokes the dead generation first, then restarts at generation + 1 with a fresh credential", async () => {
		const rig = await boot(make, { backoffMinMs: 400, backoffMaxMs: 400 });
		const daemon = await rig.pairUp();
		expect(rig.entry().workspace?.enrollment?.generation).toBe(1);
		await rig.crash(daemon);

		// Backing off: the roster says reconnecting and the dead credential is already revoked.
		await waitFor(() => rig.entry().status === "reconnecting", 5_000, "restart backing off");
		expect(rig.entry().workspace?.enrollment).toBeUndefined();
		expect(rig.entry().lifecycleStage).toBe("runtime");
		expect(rig.launches().map((l) => l.generation)).toEqual([1]);

		await waitFor(() => rig.launches().length === 2, 5_000, "restart launch");
		const [first, second] = rig.launches();
		expect(second!.generation).toBe(first!.generation + 1);
		await waitFor(
			() => rig.entry().workspace?.authorizedGeneration === 2,
			5_000,
			"generation 2 authorized",
		);
		expect(rig.entry().workspace?.enrollment?.generation).toBe(2);
		await rig.pairUp();
		expect(rig.launches()[1]!.token).not.toBe(first!.token);
		expect(rig.entry().status).not.toBe("error");
	});

	test("a crash loop past the cap gives up as status error + lifecycleStage failed with the reason", async () => {
		const rig = await boot(make, { restartMax: 2 });
		const daemon = await rig.pairUp();
		rig.poisonReplacements();
		await rig.crash(daemon);

		await waitFor(() => rig.entry().lifecycleStage === "failed", 10_000, "failed after the cap");
		const entry = rig.entry();
		expect(entry.status).toBe("error");
		expect(entry.error).toContain("restart budget exhausted (2 restarts allowed");
		expect(entry.lifecycleError).toBe(entry.error);
		// The original launch plus exactly the two restarts the cap allows, and nothing after.
		expect(rig.launches().map((l) => l.generation)).toEqual([1, 2, 3]);
		await Bun.sleep(300);
		expect(rig.launches()).toHaveLength(3);
		expect(rig.entry().status).toBe("error");
	});

	test("a pair that holds refills the cap, so it bounds crash loops and not lifetime restarts", async () => {
		const rig = await boot(make, { restartMax: 1, stablePairMs: 100 });
		const first = await rig.pairUp();
		await rig.crash(first);
		await waitFor(() => rig.launches().length === 2, 5_000, "first restart");
		const second = await rig.pairUp();
		await Bun.sleep(400); // The pair holds past stablePairMs: the one allowed restart is forgiven.
		await rig.crash(second);
		await waitFor(() => rig.launches().length === 3, 8_000, "second restart after a stable pair");
		expect(rig.entry().lifecycleStage).not.toBe("failed");
		expect(rig.entry().status).not.toBe("error");
	});

	for (const code of [77, 78]) {
		test(`exit ${code} never restarts: the row goes asleep with the reason and an explicit start brings it back`, async () => {
			const rig = await boot(make);
			const daemon = await rig.pairUp();
			await rig.crash(daemon, code);

			await waitFor(() => rig.entry().status === "asleep", 8_000, `asleep after exit ${code}`);
			expect(rig.entry().error).toContain(REASON(code));
			expect(rig.entry().lifecycleStage).toBeUndefined();
			expect(rig.entry().workspace?.enrollment).toBeUndefined();
			await Bun.sleep(500); // Several backoffs and watch cadences.
			expect(rig.launches().map((l) => l.generation)).toEqual([1]);

			await rig.start();
			await waitFor(() => rig.launches().length === 2, 5_000, "explicit start");
			expect(rig.launches()[1]!.generation).toBe(2);
		});
	}

	test("an explicit stop cancels a restart that is backing off", async () => {
		const rig = await boot(make, { backoffMinMs: 600, backoffMaxMs: 600 });
		const daemon = await rig.pairUp();
		await rig.crash(daemon);
		await waitFor(() => rig.entry().status === "reconnecting", 5_000, "restart backing off");

		await rig.stop();
		await Bun.sleep(1_200); // Well past the backoff window.
		expect(rig.launches().map((l) => l.generation)).toEqual([1]);
		expect(rig.entry().status).toBe("asleep");
	});
});
