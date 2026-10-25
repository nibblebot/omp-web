/**
 * Clone runtime that dies AFTER its callback pair came up (kata zn0e).
 *
 * The lifecycle owner's runtime watch must restart a desired-running clone
 * whose provider-proven runtime is gone: revoke the predecessor's credential,
 * prove the predecessor gone via provider inspect, then ensure-running at
 * generation + 1 with a fresh credential, on the shared restart policy
 * (restart-policy.ts: jittered backoff, budget refilled by a stable pair).
 * The policy shared with host sessions is proven in restart-policy-parity.test.ts;
 * this file keeps the clone-specific cases (provider reasons, exit 77/78).
 * Fixtures live in clone-crash.testkit.ts.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	bootCloneCrashFixture as boot,
	teardownCloneCrashFixture as teardown,
	waitForCloneRoster as waitForRoster,
} from "./clone-crash.testkit";
import { cleanupTempDirs, pinSettingsInMemory, postJson } from "./server.testkit";

afterAll(cleanupTempDirs);

await pinSettingsInMemory();

describe("clone runtime that dies after pair-up", () => {
	test(
		"runtime killed after pair-up returns to running with generation+1",
		async () => {
			const fx = await boot({});
			try {
				const first = await fx.pairUp();
				await waitForRoster(
					fx,
					() => fx.server.registry.get(fx.workspaceId)?.lifecycleStage === "ready",
					5_000,
					"pair-up ready",
				);
				const gen1 = JSON.parse(readFileSync(join(fx.stateDir, "callback-env.json"), "utf8")) as {
					env: Record<string, string>;
				};

				await fx.kill(first);

				await waitForRoster(
					fx,
					() => {
						const entry = fx.server.registry.get(fx.workspaceId);
						return entry?.workspace?.authorizedGeneration === 2 && entry.status === "ready";
					},
					8_000,
					"restart at generation 2",
				);
				const entry = fx.server.registry.get(fx.workspaceId)!;
				expect(entry.workspace?.desiredState).toBe("running");
				expect(entry.workspace?.enrollment?.generation).toBe(2);
				expect(fx.ensureGenerations()).toEqual([1, 2]);
				// Predecessor proven gone BEFORE the replacement ensure.
				const ops = fx.ops().map((o) => o.op);
				expect(ops.lastIndexOf("inspect")).toBeLessThan(ops.lastIndexOf("ensure-running"));
				// Fresh credential per generation.
				const gen2 = JSON.parse(readFileSync(join(fx.stateDir, "callback-env.json"), "utf8")) as {
					generation: number;
					env: Record<string, string>;
				};
				expect(gen2.generation).toBe(2);
				expect(gen2.env.OMP_SESSION_CALLBACK_TOKEN).not.toBe(gen1.env.OMP_SESSION_CALLBACK_TOKEN);
				// The restarted runtime pairs with the new credential and the roster settles ready.
				await fx.pairUp();
				await waitForRoster(
					fx,
					() => fx.server.registry.get(fx.workspaceId)?.lifecycleStage === "ready",
					5_000,
					"gen-2 pair-up ready",
				);
			} finally {
				await teardown(fx);
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"a pair that drops while the runtime is alive never restarts",
		async () => {
			const fx = await boot({});
			try {
				const session = await fx.pairUp();
				await waitForRoster(
					fx,
					() => fx.server.registry.get(fx.workspaceId)?.lifecycleStage === "ready",
					5_000,
					"pair-up ready",
				);
				await session.stop(); // Pair gone, runtime (marker) alive.
				// Several pair-loss graces and inspect cadences pass.
				await Bun.sleep(1_000);
				expect(fx.ensureGenerations()).toEqual([1]);
				expect(fx.ops().some((o) => o.op === "stop")).toBe(false);
				const entry = fx.server.registry.get(fx.workspaceId)!;
				expect(entry.workspace?.authorizedGeneration).toBe(1);
				expect(entry.status).toBe("ready");
			} finally {
				await teardown(fx);
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"a restart loop reaches failed with the reason once the budget is spent",
		async () => {
			const fx = await boot({ restartMax: 2 });
			try {
				const first = await fx.pairUp();
				await waitForRoster(
					fx,
					() => fx.server.registry.get(fx.workspaceId)?.lifecycleStage === "ready",
					5_000,
					"pair-up ready",
				);
				// Every replacement runtime is dead on arrival.
				writeFileSync(join(fx.stateDir, "die-on-ensure"), "1");
				await fx.kill(first);

				await waitForRoster(
					fx,
					() => fx.server.registry.get(fx.workspaceId)?.lifecycleStage === "failed",
					8_000,
					"failed after the restart budget",
				);
				const entry = fx.server.registry.get(fx.workspaceId)!;
				expect(entry.status).toBe("error");
				expect(entry.error ?? "").toContain("restart budget exhausted");
				expect(entry.error ?? "").toContain("2 restarts allowed");
				expect(entry.lifecycleError ?? "").toContain("runtime");
				// The failure is surfaced, not silently downgraded to a stop.
				expect(entry.workspace?.desiredState).toBe("running");
				// restartMax = 2: the original start plus exactly two restarts.
				expect(fx.ensureGenerations()).toEqual([1, 2, 3]);
				await Bun.sleep(300);
				expect(fx.ensureGenerations()).toEqual([1, 2, 3]);
			} finally {
				await teardown(fx);
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"a pair that holds refills the budget, so restarts bound crash loops and not lifetime restarts",
		async () => {
			const fx = await boot({ restartMax: 1, stablePairMs: 100 });
			try {
				const first = await fx.pairUp();
				await fx.kill(first);
				await waitForRoster(
					fx,
					() => fx.server.registry.get(fx.workspaceId)?.workspace?.authorizedGeneration === 2,
					8_000,
					"first restart",
				);
				const second = await fx.pairUp();
				// The pair holds past stablePairMs: the one allowed restart is forgiven.
				await Bun.sleep(400);
				await fx.kill(second);
				await waitForRoster(
					fx,
					() => fx.server.registry.get(fx.workspaceId)?.workspace?.authorizedGeneration === 3,
					8_000,
					"second restart after a stable pair",
				);
				expect(fx.server.registry.get(fx.workspaceId)!.lifecycleStage).not.toBe("failed");
			} finally {
				await teardown(fx);
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"explicit stop never restarts, even while a restart is backing off",
		async () => {
			const fx = await boot({ backoffMinMs: 600, backoffMaxMs: 600 });
			try {
				const session = await fx.pairUp();
				await waitForRoster(
					fx,
					() => fx.server.registry.get(fx.workspaceId)?.lifecycleStage === "ready",
					5_000,
					"pair-up ready",
				);
				await fx.kill(session);
				// The runtime death is observed and a restart is queued behind its backoff.
				await waitForRoster(
					fx,
					() => fx.server.registry.get(fx.workspaceId)?.status === "reconnecting",
					5_000,
					"restart backing off",
				);
				const stop = await postJson(fx.server.port, "/ctl/stop", { selector: fx.workspaceId });
				expect(stop.status).toBe(200);
				// Well past the backoff window.
				await Bun.sleep(1_200);
				expect(fx.ensureGenerations()).toEqual([1]);
				const entry = fx.server.registry.get(fx.workspaceId)!;
				expect(entry.workspace?.desiredState).toBe("stopped");
				expect(entry.status).toBe("asleep");
				rmSync(join(fx.stateDir, "dead"), { force: true });
			} finally {
				await teardown(fx);
			}
		},
		{ timeout: 20_000 },
	);
});

describe("clone runtime exit reported by the provider", () => {
	test(
		"a start whose pair never came up fails with the provider's exit detail",
		async () => {
			const fx = await boot({});
			try {
				await fx.kill(undefined, {
					exitCode: 1,
					detail: "container exited 1 (Error): boom while booting",
				});
				await waitForRoster(
					fx,
					() => fx.server.registry.get(fx.workspaceId)?.lifecycleStage === "failed",
					5_000,
					"failed before the pair",
				);
				const entry = fx.server.registry.get(fx.workspaceId)!;
				expect(entry.status).toBe("error");
				expect(entry.error ?? "").toContain("before the callback pair established");
				expect(entry.error ?? "").toContain("container exited 1 (Error): boom while booting");
				expect(entry.lifecycleError).toBe(entry.error);
				expect(fx.ensureGenerations()).toEqual([1]);
			} finally {
				await teardown(fx);
			}
		},
		{ timeout: 20_000 },
	);

	test(
		"the exit detail rides the budget-exhausted reason of a crash loop",
		async () => {
			const fx = await boot({ restartMax: 1 });
			try {
				const first = await fx.pairUp();
				await waitForRoster(
					fx,
					() => fx.server.registry.get(fx.workspaceId)?.lifecycleStage === "ready",
					5_000,
					"pair-up ready",
				);
				writeFileSync(join(fx.stateDir, "die-on-ensure"), "1");
				await fx.kill(first, { exitCode: 137, detail: "container exited 137 (OOMKilled)" });
				await waitForRoster(
					fx,
					() => fx.server.registry.get(fx.workspaceId)?.lifecycleStage === "failed",
					8_000,
					"failed after the restart budget",
				);
				const entry = fx.server.registry.get(fx.workspaceId)!;
				expect(entry.error ?? "").toContain("container exited 137 (OOMKilled)");
				expect(entry.error ?? "").toContain("restart budget exhausted");
			} finally {
				await teardown(fx);
			}
		},
		{ timeout: 20_000 },
	);

	for (const code of [77, 78]) {
		test(
			`exit ${code} never restarts: the clone goes asleep with the provider's reason, like a host child`,
			async () => {
				const fx = await boot({});
				try {
					const session = await fx.pairUp();
					await waitForRoster(
						fx,
						() => fx.server.registry.get(fx.workspaceId)?.lifecycleStage === "ready",
						5_000,
						"pair-up ready",
					);
					await fx.kill(session, {
						exitCode: code,
						detail: `container exited ${code} (Error): session file not found`,
					});
					await waitForRoster(
						fx,
						() => fx.server.registry.get(fx.workspaceId)?.status === "asleep",
						5_000,
						"asleep after a deterministic exit",
					);
					const entry = fx.server.registry.get(fx.workspaceId)!;
					expect(entry.error).toBe(`container exited ${code} (Error): session file not found`);
					expect(entry.lifecycleStage).toBeUndefined();
					expect(entry.workspace?.desiredState).toBe("stopped");
					expect(entry.workspace?.enrollment).toBeUndefined();
					// Well past several watch cadences and backoffs: still no restart.
					await Bun.sleep(600);
					expect(fx.ensureGenerations()).toEqual([1]);
					// An explicit start brings it back at the next generation.
					rmSync(join(fx.stateDir, "dead"), { force: true });
					rmSync(join(fx.stateDir, "exit.json"), { force: true });
					const started = await postJson(fx.server.port, "/ctl/start", {
						workspaceId: fx.workspaceId,
					});
					expect(started.status).toBe(200);
					expect(fx.ensureGenerations()).toEqual([1, 2]);
					expect(readFileSync(join(fx.stateDir, "callback-env.json"), "utf8")).toContain(
						'"generation":2',
					);
				} finally {
					await teardown(fx);
				}
			},
			{ timeout: 20_000 },
		);
	}
});
