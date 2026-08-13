import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bootStatusFor, Registry } from "./registry";

const tmpDirs: string[] = [];

function tmpStatePath(): string {
	const dir = mkdtempSync(join(tmpdir(), "omp-session-registry-"));
	tmpDirs.push(dir);
	return join(dir, "state.json");
}

afterAll(() => {
	for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

type CreateInit = Parameters<Registry["create"]>[0];

/** Minimal valid create() payload; override any field. */
function baseInit(overrides: Partial<CreateInit> = {}): CreateInit {
	return {
		name: "demo",
		cwd: "/tmp/proj-a",
		project: "proj-a",
		labels: [],
		mode: "spawned",
		...overrides,
	};
}

function loadedRegistry(statePath: string): Promise<Registry> {
	const registry = new Registry(statePath);
	return registry.load().then(() => registry);
}

describe("Registry", () => {
	test("missing state file loads as an empty registry; first id is d1", async () => {
		const registry = await loadedRegistry(tmpStatePath());
		expect(registry.list()).toEqual([]);
		expect(registry.get("d1")).toBeUndefined();
		const entry = registry.create(baseInit());
		expect(entry.daemonId).toBe("d1");
		expect(entry.status).toBe("spawning");
		expect(entry.registeredAt).toBeGreaterThan(0);
	});

	test("create stores every field incl. endpoint/token/labels/template", async () => {
		const registry = await loadedRegistry(tmpStatePath());
		const entry = registry.create(
			baseInit({
				name: "alpha",
				cwd: "/srv/repos/web",
				project: "web",
				worktreeOf: "main",
				labels: ["env=prod", "team=core"],
				mode: "remote",
				endpoint: "ws://10.0.0.5:9000",
				token: "secret-token",
				template: "local",
				status: "ready",
			}),
		);
		expect(registry.get(entry.daemonId)).toEqual(entry);
		expect(registry.get(entry.daemonId)).toMatchObject({
			name: "alpha",
			cwd: "/srv/repos/web",
			project: "web",
			worktreeOf: "main",
			labels: ["env=prod", "team=core"],
			mode: "remote",
			endpoint: "ws://10.0.0.5:9000",
			token: "secret-token",
			template: "local",
			status: "ready",
		});
	});

	test("persistence round-trip: reload from disk deep-equals memory", async () => {
		const statePath = tmpStatePath();
		const registry = await loadedRegistry(statePath);
		const a = registry.create(
			baseInit({ name: "alpha", endpoint: "ws://10.0.0.5:9000", token: "t0", labels: ["env=prod"] }),
		);
		const b = registry.create(
			baseInit({ name: "beta", cwd: "/tmp/proj-b", project: "proj-b", mode: "attached", endpoint: "wss://remote:4721" }),
		);
		registry.setStatus(a.daemonId, "ready");
		registry.setStatus(b.daemonId, "error", "connect refused");

		const reloaded = await loadedRegistry(statePath);
		expect(reloaded.list()).toEqual(registry.list());
		expect(reloaded.list().map((e) => e.daemonId)).toEqual(["d1", "d2"]);
		// nextId is persisted too.
		expect(JSON.parse(readFileSync(statePath, "utf8")).nextId).toBe(3);
	});

	test("dN allocation is monotonic across remove and reload (no id reuse)", async () => {
		const statePath = tmpStatePath();
		const registry = await loadedRegistry(statePath);
		expect(registry.create(baseInit()).daemonId).toBe("d1");
		expect(registry.create(baseInit()).daemonId).toBe("d2");
		expect(registry.remove("d1")).toBe(true);
		// Same instance: the counter already advanced.
		expect(registry.create(baseInit()).daemonId).toBe("d3");

		// Reload from disk: d1 stays gone and the counter stays advanced.
		const reloaded = await loadedRegistry(statePath);
		expect(reloaded.list().map((e) => e.daemonId)).toEqual(["d2", "d3"]);
		expect(reloaded.create(baseInit()).daemonId).toBe("d4");
	});

	test("atomic save: disk always holds complete JSON and never leaves tmp files", async () => {
		const statePath = tmpStatePath();
		const registry = await loadedRegistry(statePath);
		for (let i = 0; i < 5; i++) registry.create(baseInit({ name: `daemon-${i}` }));
		registry.update("d1", { labels: ["a=b"] });
		registry.setStatus("d2", "error", "boom");
		registry.remove("d3");

		const onDisk = JSON.parse(readFileSync(statePath, "utf8"));
		expect(onDisk.entries).toEqual(registry.list());
		expect(onDisk.nextId).toBe(6);
		expect(readdirSync(dirname(statePath)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	test("update applies a partial patch, persists, and throws on unknown id", async () => {
		const statePath = tmpStatePath();
		const registry = await loadedRegistry(statePath);
		const entry = registry.create(baseInit({ name: "old" }));
		const updated = registry.update(entry.daemonId, { name: "new", labels: ["x=1"] });
		expect(updated).not.toBe(entry); // copy-on-update
		expect(registry.get(entry.daemonId)).toBe(updated);
		expect(registry.get(entry.daemonId)).toMatchObject({ name: "new", cwd: "/tmp/proj-a" });
		expect(() => registry.update("d99", { name: "x" })).toThrow("d99");

		const reloaded = await loadedRegistry(statePath);
		expect(reloaded.get("d1")?.name).toBe("new");
	});

	test("setStatus sets and clears the error field", async () => {
		const statePath = tmpStatePath();
		const registry = await loadedRegistry(statePath);
		const entry = registry.create(baseInit());

		registry.setStatus(entry.daemonId, "error", "spawn failed: port busy");
		expect(registry.get(entry.daemonId)).toMatchObject({ status: "error", error: "spawn failed: port busy" });

		// Any non-error transition clears the error.
		registry.setStatus(entry.daemonId, "ready");
		expect(registry.get(entry.daemonId)?.status).toBe("ready");
		expect(registry.get(entry.daemonId)?.error).toBeUndefined();

		// "error" without a message clears a previous error too.
		registry.setStatus(entry.daemonId, "error", "boom");
		registry.setStatus(entry.daemonId, "error");
		expect(registry.get(entry.daemonId)?.error).toBeUndefined();

		// Status and cleared error survive a reload.
		const reloaded = await loadedRegistry(statePath);
		expect(reloaded.get(entry.daemonId)?.status).toBe("error");
		expect(reloaded.get(entry.daemonId)?.error).toBeUndefined();

		expect(() => registry.setStatus("d99", "ready")).toThrow("d99");
	});

	test("remove returns false for unknown ids and persists the removal", async () => {
		const statePath = tmpStatePath();
		const registry = await loadedRegistry(statePath);
		const a = registry.create(baseInit({ name: "a" }));
		registry.create(baseInit({ name: "b" }));
		expect(registry.remove("d99")).toBe(false);
		expect(registry.remove(a.daemonId)).toBe(true);
		expect(registry.get(a.daemonId)).toBeUndefined();
		expect(registry.list().map((e) => e.daemonId)).toEqual(["d2"]);

		const reloaded = await loadedRegistry(statePath);
		expect(reloaded.list().map((e) => e.daemonId)).toEqual(["d2"]);
	});

	test("list returns a defensive copy", async () => {
		const registry = await loadedRegistry(tmpStatePath());
		registry.create(baseInit({ name: "a" }));
		registry.create(baseInit({ name: "b" }));
		const snapshot = registry.list();
		snapshot.pop();
		expect(registry.list()).toHaveLength(2);
	});

	test("onChange fires on every mutation but not on load or failed remove", async () => {
		const registry = await loadedRegistry(tmpStatePath());
		let fired = 0;
		registry.onChange = () => {
			fired++;
		};
		const entry = registry.create(baseInit()); // 1
		registry.update(entry.daemonId, { name: "x" }); // 2
		registry.setStatus(entry.daemonId, "ready"); // 3
		expect(registry.remove("d99")).toBe(false); // not a mutation
		registry.remove(entry.daemonId); // 4
		await registry.load(); // initialization, not a mutation
		registry.create(baseInit()); // 5
		expect(fired).toBe(5);
	});

	test("corrupt state files throw with the path in the message", async () => {
		const statePath = tmpStatePath();
		writeFileSync(statePath, "{ definitely not json");
		await expect(new Registry(statePath).load()).rejects.toThrow(statePath);

		writeFileSync(statePath, JSON.stringify({ nextId: "oops", entries: [] }));
		await expect(new Registry(statePath).load()).rejects.toThrow(statePath);

		writeFileSync(statePath, JSON.stringify({ nextId: 1, entries: [{ name: "missing-daemonId" }] }));
		await expect(new Registry(statePath).load()).rejects.toThrow(statePath);
	});

	test("nextId is floored above the highest id on disk (no reuse after hand-edit)", async () => {
		const statePath = tmpStatePath();
		writeFileSync(
			statePath,
			JSON.stringify({
				nextId: 2,
				entries: [
					{ daemonId: "d5", name: "x", cwd: "/x", project: "x", labels: [], mode: "spawned", status: "ready", registeredAt: 1 },
				],
			}),
		);
		const registry = await loadedRegistry(statePath);
		expect(registry.create(baseInit()).daemonId).toBe("d6");
	});
});

describe("bootStatusFor (#3 boot reconciliation)", () => {
	const spawned = { mode: "spawned" as const };
	const remote = { mode: "remote" as const };
	const attached = { mode: "attached" as const };

	test("terminal statuses are kept for every mode", () => {
		expect(bootStatusFor({ ...spawned, status: "error" })).toBeNull();
		expect(bootStatusFor({ ...spawned, status: "asleep" })).toBeNull();
		expect(bootStatusFor({ ...remote, status: "error" })).toBeNull();
		expect(bootStatusFor({ ...remote, status: "asleep" })).toBeNull();
		expect(bootStatusFor({ ...attached, status: "asleep" })).toBeNull();
	});

	test("spawned entries: every non-terminal status (incl. spawning) → asleep", () => {
		for (const status of ["spawning", "connecting", "session", "resolving", "ready", "reconnecting"] as const) {
			expect(bootStatusFor({ ...spawned, status })).toBe("asleep");
		}
	});

	test("remote/attached: spawning (failed spawn) → asleep; other non-terminal → connecting (redial)", () => {
		expect(bootStatusFor({ ...remote, status: "spawning" })).toBe("asleep");
		expect(bootStatusFor({ ...attached, status: "spawning" })).toBe("asleep");
		for (const status of ["connecting", "session", "resolving", "ready", "reconnecting"] as const) {
			expect(bootStatusFor({ ...remote, status })).toBe("connecting");
			expect(bootStatusFor({ ...attached, status })).toBe("connecting");
		}
	});
});
