/**
 * CLI end-to-end tests for fleet/server.ts ("CLI" describe): the omp-fleet
 * subcommands exercised in-process against a booted fleet (sessions table,
 * parse-error exits) plus one true end-to-end Bun.spawn'd serve + sessions
 * pair against a seeded state copy.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "./cli";
import { Registry, type RegistryEntry } from "./registry";
import { startFleet, type FleetServer } from "./server";
import { FAKE_CWD, cleanupTempDirs, fleetPaths, pinSettingsInMemory } from "./server.testkit";

// bun 1.3.14 attributes afterAll hooks registered in imported modules to the
// first importer only; register cleanup in this file's own module scope.
afterAll(cleanupTempDirs);

// Pin the process-global Settings singleton in-memory. Lives here, not in the
// testkit: a top-level await in an imported module races the bun 1.3.14
// parallel test-file loader (importers sporadically see its bindings in TDZ).
await pinSettingsInMemory();

describe("CLI", () => {
	let tmp: string;
	let statePath: string;
	let configPath: string;
	let server: FleetServer;
	let seeded: RegistryEntry;

	beforeAll(async () => {
		({ tmp, statePath, configPath } = fleetPaths());
		writeFileSync(configPath, JSON.stringify({}));
		// Seed the registry directly so `sessions` has a row to print.
		const registry = new Registry(statePath);
		await registry.load();
		seeded = registry.create({
			name: "cli-smoke",
			cwd: FAKE_CWD,
			project: "fake-proj",
			labels: ["env=test"],
			mode: "remote",
			endpoint: "ws://127.0.0.1:1",
			token: "t",
			status: "asleep",
		});
		server = await startFleet({ port: 0, statePath, configPath });
	});

	afterAll(async () => {
		if (server !== undefined) await server.close();
	});

	test("main(['sessions']) prints a table via fetch end-to-end", async () => {
		const logs: string[] = [];
		const originalLog = console.log;
		console.log = (msg?: unknown) => {
			logs.push(String(msg));
		};
		try {
			const code = await main(["sessions", "--port", String(server.port)]);
			expect(code).toBe(0);
		} finally {
			console.log = originalLog;
		}
		const output = logs.join("\n");
		expect(output).toContain("id");
		expect(output).toContain(seeded.daemonId);
		expect(output).toContain("cli-smoke");
		expect(output).toContain("env=test");
	});

	test("main with a refused connection exits 1 with the not-running message", async () => {
		// Find a port with no listener: bind and release a server first.
		const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
		const freePort = probe.port;
		probe.stop(true);
		const errors: string[] = [];
		const originalError = console.error;
		console.error = (msg?: unknown) => {
			errors.push(String(msg));
		};
		try {
			const code = await main(["sessions", "--port", String(freePort)]);
			expect(code).toBe(1);
		} finally {
			console.error = originalError;
		}
		expect(errors.join("\n")).toContain("fleet not running — start it: omp-fleet serve");
	});

	test("usage no longer advertises the removed --fan-out flag (audit #26)", async () => {
		const logs: string[] = [];
		const originalLog = console.log;
		console.log = (msg?: unknown) => {
			logs.push(String(msg));
		};
		try {
			const code = await main(["help"]);
			expect(code).toBe(0);
		} finally {
			console.log = originalLog;
		}
		const output = logs.join("\n");
		expect(output).not.toContain("--fan-out");
		expect(output).toContain("prompt <selector> <text> [--wait <ms>]");
	});

	test("a flag value starting with '-' errors instead of being silently dropped (audit #26)", async () => {
		const errors: string[] = [];
		const originalError = console.error;
		console.error = (msg?: unknown) => {
			errors.push(String(msg));
		};
		try {
			// --wait -1 previously parsed as boolean true (value "dropped" and
			// "-1" leaked into the prompt text); now it is a parse error.
			const code = await main(["prompt", "x", "hi", "--wait", "-1"]);
			expect(code).toBe(1);
		} finally {
			console.error = originalError;
		}
		expect(errors.join("\n")).toContain("invalid value for --wait: -1");
	});

	test("a flag with no value at the end of argv errors (audit #26)", async () => {
		const errors: string[] = [];
		const originalError = console.error;
		console.error = (msg?: unknown) => {
			errors.push(String(msg));
		};
		try {
			const code = await main(["sessions", "--port"]);
			expect(code).toBe(1);
		} finally {
			console.error = originalError;
		}
		expect(errors.join("\n")).toContain("missing value for --port");
	});

	test("CLI serve + sessions end-to-end via Bun.spawn", async () => {
		// The describe's in-process fleet holds the state lock on statePath;
		// a second fleet on the SAME path now fails loudly (that is the lock's
		// contract). Serve reads a copy of the seeded state instead, so the
		// e2e flow (serve boots + sessions lists the seeded roster) still runs.
		const serveStatePath = join(tmp, "serve-state.json");
		copyFileSync(statePath, serveStatePath);
		const serve = Bun.spawn(["bun", "fleet/cli.ts", "serve", "--port", "0"], {
			cwd: join(import.meta.dir, ".."),
			env: { ...process.env, OMP_FLEET_STATE: serveStatePath, OMP_FLEET_CONFIG: configPath },
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			const port = await readListeningPort(serve.stdout, 10_000);
			expect(port).toBeGreaterThan(0);
			const sessions = Bun.spawn(["bun", "fleet/cli.ts", "sessions", "--port", String(port)], {
				cwd: join(import.meta.dir, ".."),
				env: { ...process.env, OMP_FLEET_STATE: statePath, OMP_FLEET_CONFIG: configPath },
				stdout: "pipe",
				stderr: "pipe",
			});
			const out = await readAll(sessions.stdout);
			const errText = await readAll(sessions.stderr);
			const exit = await sessions.exited;
			expect(exit).toBe(0);
			expect(out).toContain(seeded.daemonId);
			expect(out).toContain("cli-smoke");
			expect(errText).toBe("");
		} finally {
			serve.kill("SIGTERM");
			const { promise: timeout, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 5000);
			await Promise.race([serve.exited, timeout]);
			if (serve.exitCode === null) serve.kill("SIGKILL");
		}
	});
});

/** Read the spawned `serve` stdout until it reports its listening port. */
async function readListeningPort(
	stream: ReadableStream<Uint8Array>,
	timeoutMs: number,
): Promise<number> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const deadline = Date.now() + timeoutMs;
	try {
		while (Date.now() < deadline) {
			const remaining = deadline - Date.now();
			const { promise: timer, resolve } = Promise.withResolvers<null>();
			setTimeout(() => resolve(null), remaining);
			const result = (await Promise.race([reader.read(), timer])) as {
				value?: Uint8Array;
				done?: boolean;
			} | null;
			if (result === null || result.done) break;
			buffer += decoder.decode(result.value, { stream: true });
			const match = /fleet listening on 127\.0\.0\.1:(\d+)/.exec(buffer);
			if (match) return Number(match[1]);
		}
	} finally {
		reader.cancel().catch(() => {});
	}
	throw new Error(`serve did not report a port within ${timeoutMs}ms; stdout so far: ${buffer}`);
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
	}
	return buffer;
}
