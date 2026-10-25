/**
 * HostRuntimeProvider unit tests: the in-process four-op runtime contract for
 * sessions that run as children of the fleet. Real `sh -c` children; no
 * lifecycle, registry or transport. Covers ensure-running (idempotent at one
 * generation, replace at a new one without reporting an exit, stdin payload,
 * launch failures), inspect (running, stopped, missing), stop (process group,
 * SIGKILL after the grace), delete (logs removed), and the onExit contract: a
 * crash is reported once with its exit code and generation, an expected
 * termination never.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { HostRuntimeProvider, type HostExit, type HostRequest } from "../host-provider";
import type { RegistryEntry } from "../registry";

afterAll(cleanupTempDirs);

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

async function waitFor<T>(probe: () => T | null, timeoutMs: number, label: string): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== null) return value;
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label} (${timeoutMs}ms)`);
		await sleep(25);
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** A pid that existed and exited, for dead-pid liveness evidence. */
async function exitedPid(): Promise<number> {
	const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
		stdout: "ignore",
		stderr: "ignore",
	});
	await child.exited;
	return child.pid;
}

/** Idles until SIGTERM (default action: dies), ticking short so teardown is quick. */
const IDLE = "while :; do sleep 0.05; done";

interface Rig {
	provider: HostRuntimeProvider;
	exits: HostExit[];
	dir: string;
	logPath: string;
	/** A ready-made request for workspace `id` at `generation`. */
	request: (
		op: HostRequest["op"],
		extra?: Omit<Partial<HostRequest>, "entry"> & { id?: string; entry?: Partial<RegistryEntry> },
	) => HostRequest;
}

function makeRig(): Rig {
	const exits: HostExit[] = [];
	const provider = new HostRuntimeProvider((exit) => exits.push(exit));
	const dir = tempDir("host-provider-");
	const logPath = join(dir, "logs", "d1.log");
	const request: Rig["request"] = (op, extra = {}) => {
		const { id = "d1", entry, ...rest } = extra;
		return {
			op,
			workspaceId: id,
			generation: 1,
			entry: {
				workspaceId: id,
				name: "host-session",
				cwd: dir,
				project: "host-provider",
				status: "connecting",
				registeredAt: 1,
				...entry,
			},
			logPath,
			...rest,
		};
	};
	// Every launched child is ended by teardown, whatever the test did.
	cleanups.push(async () => {
		for (const id of ["d1", "d2"]) await provider.run(request("stop", { id, killGraceMs: 200 }));
	});
	return { provider, exits, dir, logPath, request };
}

function launch(command: string, stdin = "{}"): HostRequest["launch"] {
	return { command, stdin };
}

describe("HostRuntimeProvider ensure-running", () => {
	test("launches a detached child with the stdin payload and reports it running and owned", async () => {
		const rig = makeRig();
		const stdinFile = join(rig.dir, "stdin.txt");
		const response = await rig.provider.run(
			rig.request("ensure-running", {
				launch: launch(`cat > '${stdinFile}'; ${IDLE}`, '{"pair":"payload"}'),
			}),
		);
		expect(response).toMatchObject({ ok: true, observed: "running", owned: true });
		if (!response.ok) throw new Error("unreachable");
		expect(response.pid).toBeTypeOf("number");
		expect(response.exit).toBeUndefined();
		expect(rig.provider.pidOf("d1")).toBe(response.pid);
		await waitFor(
			() => (existsSync(stdinFile) ? readFileSync(stdinFile, "utf8") : null),
			5000,
			"stdin payload",
		);
		expect(readFileSync(stdinFile, "utf8")).toBe('{"pair":"payload"}');
	});

	test("is idempotent at the same generation: one child, the same pid, no second launch", async () => {
		const rig = makeRig();
		const launches = join(rig.dir, "launches.txt");
		const request = rig.request("ensure-running", {
			launch: launch(`echo launched >> '${launches}'; ${IDLE}`),
		});
		const first = await rig.provider.run(request);
		const second = await rig.provider.run(request);
		if (!first.ok || !second.ok) throw new Error("ensure-running failed");
		expect(second.pid).toBe(first.pid);
		expect(second.owned).toBe(true);
		expect(second.startedAt).toBe(first.startedAt);
		await sleep(150); // a second launch would have written by now
		expect(readFileSync(launches, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
		expect(rig.exits).toEqual([]);
	});

	test("replaces the child at a new generation without reporting an exit", async () => {
		const rig = makeRig();
		const first = await rig.provider.run(
			rig.request("ensure-running", { launch: launch(IDLE), killGraceMs: 200 }),
		);
		const second = await rig.provider.run(
			rig.request("ensure-running", { generation: 2, launch: launch(IDLE), killGraceMs: 200 }),
		);
		if (!first.ok || !second.ok) throw new Error("ensure-running failed");
		expect(second.pid).not.toBe(first.pid);
		expect(second.owned).toBe(true);
		// The replaced predecessor's death is reported on the response, not as a crash.
		expect(second.exit).toMatch(/^exit code=/);
		expect(isAlive(first.pid!)).toBe(false);
		expect(rig.provider.pidOf("d1")).toBe(second.pid);
		await sleep(150);
		expect(rig.exits).toEqual([]);
	});

	test("appends to the session log across launches and rotates an over-cap log", async () => {
		const rig = makeRig();
		await rig.provider.run(
			rig.request("ensure-running", { launch: launch(`echo first-run; ${IDLE}`) }),
		);
		await waitFor(
			() =>
				existsSync(rig.logPath) && readFileSync(rig.logPath, "utf8").includes("first-run")
					? true
					: null,
			5000,
			"first log line",
		);
		await rig.provider.run(
			rig.request("ensure-running", {
				generation: 2,
				launch: launch(`echo second-run; ${IDLE}`),
				killGraceMs: 200,
			}),
		);
		await waitFor(
			() => (readFileSync(rig.logPath, "utf8").includes("second-run") ? true : null),
			5000,
			"second log line",
		);
		expect(readFileSync(rig.logPath, "utf8")).toContain("first-run");

		await rig.provider.run(rig.request("stop", { killGraceMs: 200 }));
		const oversized = "x".repeat(1024 * 1024 + 1);
		writeFileSync(rig.logPath, oversized);
		await rig.provider.run(
			rig.request("ensure-running", {
				generation: 3,
				launch: launch(`echo third-run; ${IDLE}`),
			}),
		);
		expect(readFileSync(`${rig.logPath}.1`, "utf8")).toBe(oversized);
	});

	test("a launch the provider cannot make is a typed error, not a throw", async () => {
		const rig = makeRig();
		// The log's parent directory would have to be created under a regular file.
		const blocker = join(rig.dir, "blocker");
		writeFileSync(blocker, "");
		const response = await rig.provider.run(
			rig.request("ensure-running", {
				launch: launch(IDLE),
				logPath: join(blocker, "logs", "d1.log"),
			}),
		);
		expect(response.ok).toBe(false);
		if (response.ok) throw new Error("unreachable");
		expect(response.error.message).toStartWith("spawn failed: ");
		expect(rig.provider.pidOf("d1")).toBeUndefined();
		expect(rig.exits).toEqual([]);
	});

	test("ensure-running without a launch is a typed error", async () => {
		const rig = makeRig();
		const response = await rig.provider.run(rig.request("ensure-running"));
		expect(response.ok).toBe(false);
	});

	test("never passes the fleet's own callback secrets to the child", async () => {
		const rig = makeRig();
		const envFile = join(rig.dir, "env.txt");
		const saved = {
			callback: process.env.OMP_SESSION_CALLBACK_URL,
			token: process.env.OMP_SESSION_TOKEN,
		};
		process.env.OMP_SESSION_CALLBACK_URL = "http://leak.invalid";
		process.env.OMP_SESSION_TOKEN = "leaked-token";
		try {
			await rig.provider.run(
				rig.request("ensure-running", {
					launch: launch(`env | grep '^OMP_SESSION_' | sort > '${envFile}'; ${IDLE}`),
				}),
			);
			const dump = await waitFor(
				() =>
					existsSync(envFile) && readFileSync(envFile, "utf8") !== ""
						? readFileSync(envFile, "utf8")
						: null,
				5000,
				"env dump",
			);
			expect(dump).toContain("OMP_SESSION_LOG_MIRROR=0");
			expect(dump).not.toContain("OMP_SESSION_CALLBACK_URL");
			expect(dump).not.toContain("OMP_SESSION_TOKEN");
		} finally {
			if (saved.callback === undefined) delete process.env.OMP_SESSION_CALLBACK_URL;
			else process.env.OMP_SESSION_CALLBACK_URL = saved.callback;
			if (saved.token === undefined) delete process.env.OMP_SESSION_TOKEN;
			else process.env.OMP_SESSION_TOKEN = saved.token;
		}
	});
});

describe("HostRuntimeProvider inspect", () => {
	test("observes a tracked child as running and owned, with its pid", async () => {
		const rig = makeRig();
		const started = await rig.provider.run(rig.request("ensure-running", { launch: launch(IDLE) }));
		if (!started.ok) throw new Error("ensure-running failed");
		const inspected = await rig.provider.run(rig.request("inspect"));
		expect(inspected).toMatchObject({
			ok: true,
			observed: "running",
			owned: true,
			pid: started.pid,
			startedAt: started.startedAt,
		});
		expect(rig.provider.inspect(rig.request("inspect"))).toMatchObject({
			observed: "running",
			owned: true,
			pid: started.pid,
		});
	});

	test("observes an untracked session with a dead recorded pid as stopped", async () => {
		const rig = makeRig();
		const observed = rig.provider.inspect(
			rig.request("inspect", { entry: { pid: await exitedPid() } }),
		);
		expect(observed).toMatchObject({ ok: true, observed: "stopped", owned: false });
	});

	test("observes an untracked session with a free or stale lock as stopped, a held one as running", async () => {
		const rig = makeRig();
		const sessionFile = join(rig.dir, "session.jsonl");
		expect(
			rig.provider.inspect(rig.request("inspect", { entry: { lastSessionFile: sessionFile } })),
		).toMatchObject({ observed: "stopped", owned: false }); // free lock
		writeFileSync(
			`${sessionFile}.lock`,
			JSON.stringify({ pid: await exitedPid(), name: "stale-holder", startedAt: 0 }),
		);
		expect(
			rig.provider.inspect(rig.request("inspect", { entry: { lastSessionFile: sessionFile } })),
		).toMatchObject({ observed: "stopped", owned: false }); // stale lock
		writeFileSync(
			`${sessionFile}.lock`,
			JSON.stringify({ pid: process.pid, name: "live-holder", startedAt: 0 }),
		);
		expect(
			rig.provider.inspect(rig.request("inspect", { entry: { lastSessionFile: sessionFile } })),
		).toMatchObject({ observed: "running", owned: false }); // held lock
	});

	test("observes a workspace with no evidence either way as missing", () => {
		const rig = makeRig();
		// A live recorded pid may be reused, so it proves nothing without a lock.
		expect(
			rig.provider.inspect(rig.request("inspect", { entry: { pid: process.pid } })),
		).toMatchObject({ ok: true, observed: "missing", owned: false });
		expect(rig.provider.inspect(rig.request("inspect"))).toMatchObject({
			observed: "missing",
			owned: false,
		});
	});

	test("a child that exited is no longer observed running", async () => {
		const rig = makeRig();
		await rig.provider.run(rig.request("ensure-running", { launch: launch("exit 0") }));
		await waitFor(() => (rig.exits.length > 0 ? true : null), 5000, "exit report");
		expect(rig.provider.pidOf("d1")).toBeUndefined();
		expect(rig.provider.inspect(rig.request("inspect")).owned).toBe(false);
	});
});

describe("HostRuntimeProvider stop and delete", () => {
	test("stop terminates the child's whole process group and reports it stopped", async () => {
		const rig = makeRig();
		const grandchildFile = join(rig.dir, "grandchild.pid");
		const started = await rig.provider.run(
			rig.request("ensure-running", {
				launch: launch(`sleep 30 & echo $! > '${grandchildFile}'; wait`),
			}),
		);
		if (!started.ok) throw new Error("ensure-running failed");
		const grandchild = await waitFor(
			() => {
				if (!existsSync(grandchildFile)) return null;
				const pid = Number.parseInt(readFileSync(grandchildFile, "utf8"), 10);
				return Number.isInteger(pid) && pid > 0 ? pid : null;
			},
			5000,
			"grandchild pid",
		);
		expect(isAlive(grandchild)).toBe(true);

		const stopped = await rig.provider.run(rig.request("stop", { killGraceMs: 2000 }));
		expect(stopped).toMatchObject({ ok: true, observed: "stopped", owned: false });
		if (!stopped.ok) throw new Error("unreachable");
		expect(stopped.exit).toMatch(/^exit code=/);
		expect(isAlive(started.pid!)).toBe(false);
		await waitFor(() => (isAlive(grandchild) ? null : true), 5000, "grandchild terminated");
		expect(rig.provider.pidOf("d1")).toBeUndefined();
		await sleep(150);
		expect(rig.exits).toEqual([]); // an expected termination is never reported
	});

	test("stop escalates to SIGKILL when the child ignores SIGTERM past the grace", async () => {
		const rig = makeRig();
		const readyFile = join(rig.dir, "trap-ready");
		const started = await rig.provider.run(
			rig.request("ensure-running", {
				launch: launch(`trap '' TERM; echo ready > '${readyFile}'; ${IDLE}`),
			}),
		);
		if (!started.ok) throw new Error("ensure-running failed");
		// SIGTERM must arrive after the trap is installed, or it just kills the shell.
		await waitFor(() => (existsSync(readyFile) ? true : null), 5000, "trap installed");
		const stopped = await rig.provider.run(rig.request("stop", { killGraceMs: 150 }));
		if (!stopped.ok) throw new Error("stop failed");
		expect(stopped.exit).toContain("signal=SIGKILL");
		await waitFor(() => (isAlive(started.pid!) ? null : true), 5000, "child killed");
		await sleep(150);
		expect(rig.exits).toEqual([]);
	});

	test("stop of a workspace this provider never launched signals nothing and inspects it", async () => {
		const rig = makeRig();
		const stopped = await rig.provider.run(rig.request("stop", { entry: { pid: process.pid } }));
		expect(stopped).toMatchObject({ ok: true, observed: "missing", owned: false });
		if (!stopped.ok) throw new Error("unreachable");
		expect(stopped.exit).toBeUndefined();
		expect(isAlive(process.pid)).toBe(true);
	});

	test("delete stops the child and removes the session log and its rotated generation", async () => {
		const rig = makeRig();
		const started = await rig.provider.run(
			rig.request("ensure-running", { launch: launch(`echo delete-me; ${IDLE}`) }),
		);
		if (!started.ok) throw new Error("ensure-running failed");
		await waitFor(() => (existsSync(rig.logPath) ? true : null), 5000, "session log");
		writeFileSync(`${rig.logPath}.1`, "rotated\n");

		const deleted = await rig.provider.run(rig.request("delete", { killGraceMs: 2000 }));
		expect(deleted).toMatchObject({ ok: true, observed: "missing", owned: false });
		expect(isAlive(started.pid!)).toBe(false);
		expect(existsSync(rig.logPath)).toBe(false);
		expect(existsSync(`${rig.logPath}.1`)).toBe(false);
		await sleep(150);
		expect(rig.exits).toEqual([]);
	});

	test("delete of a workspace that never ran removes its logs and succeeds", async () => {
		const rig = makeRig();
		mkdirSync(dirname(rig.logPath), { recursive: true });
		writeFileSync(rig.logPath, "old\n");
		const deleted = await rig.provider.run(rig.request("delete"));
		expect(deleted).toMatchObject({ ok: true, observed: "missing" });
		expect(existsSync(rig.logPath)).toBe(false);
	});
});

describe("HostRuntimeProvider onExit", () => {
	test("a crash is reported exactly once with its exit code and generation", async () => {
		const rig = makeRig();
		await rig.provider.run(
			rig.request("ensure-running", { generation: 7, launch: launch("exit 3") }),
		);
		await waitFor(() => (rig.exits.length > 0 ? true : null), 5000, "exit report");
		await sleep(200); // a duplicate report would have landed by now
		expect(rig.exits).toEqual([
			{ workspaceId: "d1", generation: 7, exitCode: 3, signalCode: null },
		]);
		expect(rig.provider.pidOf("d1")).toBeUndefined();
	});

	test("a child killed by a signal is reported with the signal", async () => {
		const rig = makeRig();
		const started = await rig.provider.run(rig.request("ensure-running", { launch: launch(IDLE) }));
		if (!started.ok) throw new Error("ensure-running failed");
		process.kill(started.pid!, "SIGKILL");
		const exit = await waitFor(() => rig.exits[0] ?? null, 5000, "exit report");
		expect(exit).toMatchObject({ workspaceId: "d1", generation: 1, signalCode: "SIGKILL" });
		expect(rig.exits).toHaveLength(1);
	});

	test("the crash of a replaced predecessor never surfaces; only the live child's crash does", async () => {
		const rig = makeRig();
		await rig.provider.run(
			rig.request("ensure-running", { generation: 1, launch: launch(IDLE), killGraceMs: 200 }),
		);
		const second = await rig.provider.run(
			rig.request("ensure-running", { generation: 2, launch: launch(IDLE), killGraceMs: 200 }),
		);
		if (!second.ok) throw new Error("ensure-running failed");
		await sleep(150);
		expect(rig.exits).toEqual([]);
		process.kill(second.pid!, "SIGKILL");
		const exit = await waitFor(() => rig.exits[0] ?? null, 5000, "exit report");
		expect(exit.generation).toBe(2);
		await sleep(150);
		expect(rig.exits).toHaveLength(1);
	});

	test("workspaces are tracked independently", async () => {
		const rig = makeRig();
		const a = await rig.provider.run(
			rig.request("ensure-running", { id: "d1", launch: launch(IDLE) }),
		);
		const b = await rig.provider.run(
			rig.request("ensure-running", {
				id: "d2",
				launch: launch(IDLE),
				logPath: join(rig.dir, "logs", "d2.log"),
			}),
		);
		if (!a.ok || !b.ok) throw new Error("ensure-running failed");
		expect(a.pid).not.toBe(b.pid);
		await rig.provider.run(rig.request("stop", { id: "d1", killGraceMs: 200 }));
		expect(rig.provider.pidOf("d1")).toBeUndefined();
		expect(rig.provider.pidOf("d2")).toBe(b.pid);
		expect(isAlive(b.pid!)).toBe(true);
	});
});
