import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionEntry } from "../session-entry";
import type { SubagentSnapshot } from "../subagent-mirror";
import {
	ensureWorkerReviver,
	listWorkers,
	parkWorker,
	reviveWorker,
	WorkerNotAdoptedError,
	type WorkerReviverDeps,
} from "../worker-lifecycle";

const ID = "omp-web-worker-lifecycle-test";
let dir = "";
let root = "";
let childFile = "";

interface FakeSession {
	session: AgentSession;
	disposed: () => number;
}

/** Test double: only the members the SDK lifecycle touches (park disposes; revive attaches). */
function fakeSession(): FakeSession {
	let disposed = 0;
	const session = {
		isStreaming: false,
		dispose: async () => {
			disposed += 1;
		},
	};
	// Test double: the lifecycle only reads the members above.
	return { session: session as unknown as AgentSession, disposed: () => disposed };
}

/** Stub deps: the reviver factory only captures these handles; no revive reads them in these tests. */
const stubDeps = {} as unknown as WorkerReviverDeps;

/** Test double for the per-session entry; worker-lifecycle reads only these members. */
function makeEntry(snapshotStatus: SubagentSnapshot["status"] | undefined): SessionEntry {
	const snapshots = new Map<string, SubagentSnapshot>();
	if (snapshotStatus)
		snapshots.set(ID, {
			id: ID,
			index: 0,
			agent: "explore",
			status: snapshotStatus,
			sessionFile: childFile,
			lastUpdate: 1,
		});
	const entry = {
		session: {
			sessionFile: root,
			sessionManager: { getSessionId: () => "root-session" },
		},
		agentRegistry: new AgentRegistry(),
		subagentSnapshots: snapshots,
		transcriptSessionFilesBySubagentId: new Map<string, string>(),
	};
	// Test double: the fields above are the complete surface worker-lifecycle reads.
	const typed = entry as unknown as SessionEntry;
	// Same wiring the session performs for every session (collab-session.ts createSession).
	ensureWorkerReviver(typed, stubDeps);
	return typed;
}

/** A finished Task subagent as the SDK executor leaves it: registered, live, and adopted for keep-alive. */
function adoptFinished(revive?: () => Promise<AgentSession>, sessionFile = childFile): FakeSession {
	const live = fakeSession();
	AgentRegistry.global().register({
		id: ID,
		displayName: "explore",
		kind: "sub",
		parentId: MAIN_AGENT_ID,
		session: live.session,
		sessionFile,
		status: "idle",
	});
	AgentLifecycleManager.global().adopt(ID, { idleTtlMs: 60_000, revive });
	return live;
}

afterAll(cleanupTempDirs);

beforeEach(async () => {
	dir = tempDir("omp-web-worker-lifecycle-");
	root = join(dir, "root.jsonl");
	await mkdir(join(dir, "root"));
	childFile = join(dir, "root", `${ID}.jsonl`);
	await writeFile(root, "");
	await writeFile(childFile, "");
});

afterEach(async () => {
	await AgentLifecycleManager.global().release(ID);
	AgentRegistry.global().unregister(ID);
	// A test may install its own persisted reviver; the next entry reinstalls the real one.
	AgentLifecycleManager.resetGlobalForTests();
});

describe("worker park and revive", () => {
	test("a finished Task subagent parks, is listed as parked, then revives under its own id", async () => {
		const revived = fakeSession();
		const live = adoptFinished(async () => revived.session);
		const entry = makeEntry("completed");

		expect((await listWorkers(entry))[0]).toMatchObject({ id: ID, status: "idle", adopted: true });

		const parked = await parkWorker(entry, ID);
		expect(parked).toMatchObject({ id: ID, status: "parked", parked: true, outcome: "parked" });
		expect(live.disposed()).toBe(1);

		const [parkedRow] = await listWorkers(entry);
		expect(parkedRow).toMatchObject({ id: ID, status: "parked", revivable: true });

		const result = await reviveWorker(entry, ID);
		expect(result).toMatchObject({ id: ID, status: "idle", outcome: "revived" });
		expect(AgentRegistry.global().get(ID)?.session).toBe(revived.session);
	});

	test("a failed Task subagent can be parked", async () => {
		adoptFinished(async () => fakeSession().session);
		const entry = makeEntry("failed");
		expect(await parkWorker(entry, ID)).toMatchObject({ status: "parked", parked: true });
	});

	test("a parked worker whose snapshot the lifecycle dropped revives through the global registry", async () => {
		const revived = fakeSession();
		adoptFinished(async () => revived.session);
		const entry = makeEntry(undefined);
		expect(await parkWorker(entry, ID)).toMatchObject({ status: "parked", parked: true });
		expect(await reviveWorker(entry, ID)).toMatchObject({
			id: ID,
			status: "idle",
			outcome: "revived",
		});
	});

	test("after a backend restart, a finished worker still lists from its persisted snapshot", async () => {
		// Fresh process: the registry has no entry for ID, only the persisted snapshot.
		expect(AgentRegistry.global().get(ID)).toBeUndefined();
		expect((await listWorkers(makeEntry("completed")))[0]).toMatchObject({
			id: ID,
			status: "completed",
			hasHistory: true,
		});
	});

	test("an aborted worker has no live session to park", async () => {
		adoptFinished();
		await AgentLifecycleManager.global().release(ID, undefined, { tombstone: true });
		const entry = makeEntry("completed");
		await expect(parkWorker(entry, ID)).rejects.toBeInstanceOf(WorkerNotAdoptedError);
		expect(AgentRegistry.global().get(ID)?.status).toBe("aborted");
	});

	test("a worker the session does not own rejects", async () => {
		adoptFinished(undefined, join(dir, "elsewhere", `${ID}.jsonl`));
		const entry = makeEntry(undefined);
		await expect(parkWorker(entry, ID)).rejects.toThrow(/not owned/);
	});

	test("a failing reviver surfaces its reason instead of a generic message", async () => {
		adoptFinished(async () => {
			throw new Error("workspace is gone");
		});
		const entry = makeEntry("completed");
		await parkWorker(entry, ID);
		await expect(reviveWorker(entry, ID)).rejects.toThrow(/workspace is gone/);
	});

	test("a parked worker with no reviver surfaces the SDK reason", async () => {
		adoptFinished();
		const entry = makeEntry("completed");
		await parkWorker(entry, ID);
		await expect(reviveWorker(entry, ID)).rejects.toThrow(/no reviver registered/);
	});

	test("parking a worker the lifecycle never adopted is a typed error, not a silent noop", async () => {
		AgentRegistry.global().register({
			id: ID,
			displayName: "explore",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: fakeSession().session,
			sessionFile: childFile,
			status: "idle",
		});
		const entry = makeEntry("completed");
		await expect(parkWorker(entry, ID)).rejects.toBeInstanceOf(WorkerNotAdoptedError);
		await expect(parkWorker(entry, ID)).rejects.toMatchObject({ code: "worker_not_adopted" });
	});

	test("parking an already-parked worker is idempotent: it stays parked with no session to dispose", async () => {
		adoptFinished(async () => fakeSession().session);
		const entry = makeEntry("completed");
		expect(await parkWorker(entry, ID)).toMatchObject({ outcome: "parked", parked: true });
		expect(await parkWorker(entry, ID)).toMatchObject({ outcome: "parked", parked: true });
	});

	test("after a backend restart, a parked worker with a persisted transcript reappears parked and untouched", async () => {
		const transcript = `${JSON.stringify({ type: "session", timestamp: "2026-01-01T00:00:00.000Z" })}\n${JSON.stringify({ type: "session_init", timestamp: "2026-01-01T00:00:00.000Z", task: "review the diff", agent: "explore" })}\n`;
		await writeFile(childFile, transcript);
		// Fresh process: no global registry entry and no adopted worker, only the transcript on disk.
		expect(AgentRegistry.global().get(ID)).toBeUndefined();
		const workers = await listWorkers(makeEntry(undefined));
		expect(workers).toHaveLength(1);
		expect(workers[0]).toMatchObject({
			id: ID,
			status: "parked",
			hasHistory: true,
			adopted: false,
			sessionFile: childFile,
		});
		expect(await readFile(childFile, "utf8")).toBe(transcript);
	});
});

/** A transcript carrying the persisted session contract the SDK needs to rebuild a subagent. */
function resumableTranscript(cwd: string): string {
	const timestamp = "2026-01-01T00:00:00.000Z";
	return [
		{ type: "session", version: 3, id: ID, timestamp, cwd },
		{
			type: "session_init",
			timestamp,
			task: "review the diff",
			agent: "explore",
			systemPrompt: "You review diffs.",
			tools: ["read"],
		},
	]
		.map((line) => `${JSON.stringify(line)}\n`)
		.join("");
}

/** The explicit-kill path: the ref stays registered as a detached `aborted` row. */
async function killAdopted(): Promise<void> {
	await AgentLifecycleManager.global().release(ID, undefined, { tombstone: true });
}

describe("aborted workers", () => {
	test("an aborted worker with a resumable transcript lists as revivable and revives under its own id", async () => {
		await writeFile(childFile, resumableTranscript(dir));
		adoptFinished();
		await killAdopted();
		const entry = makeEntry("completed");

		const [row] = await listWorkers(entry);
		expect(row).toMatchObject({ id: ID, status: "aborted", revivable: true, adopted: false });
		expect(row?.unavailableReason).toBeUndefined();

		// The real factory needs a live root session; a double stands in for the rebuilt subagent.
		const revived = fakeSession();
		AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
			async () => async () => revived.session,
			() => 0,
		);
		expect(await reviveWorker(entry, ID)).toMatchObject({
			id: ID,
			status: "idle",
			outcome: "revived",
		});
		expect(AgentRegistry.global().get(ID)?.session).toBe(revived.session);
		expect((await listWorkers(entry))[0]).toMatchObject({
			id: ID,
			status: "idle",
			revivable: false,
		});
	});

	test("an aborted worker with no transcript is not revivable and says why", async () => {
		AgentRegistry.global().register({
			id: ID,
			displayName: "explore",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile: null,
			status: "aborted",
		});
		const entry = makeEntry("completed");

		expect((await listWorkers(entry))[0]).toMatchObject({
			id: ID,
			status: "aborted",
			revivable: false,
			unavailableReason: "worker was stopped and has no transcript to resume from",
		});
		await expect(reviveWorker(entry, ID)).rejects.toThrow(/history/);
		expect(AgentRegistry.global().get(ID)?.status).toBe("aborted");
	});

	test("an aborted worker whose transcript carries no session contract is not revivable", async () => {
		await writeFile(
			childFile,
			`${JSON.stringify({ type: "session", version: 3, id: ID, timestamp: "2026-01-01T00:00:00.000Z", cwd: dir })}\n`,
		);
		adoptFinished();
		await killAdopted();
		const entry = makeEntry("completed");

		expect((await listWorkers(entry))[0]).toMatchObject({
			status: "aborted",
			revivable: false,
			unavailableReason: expect.stringMatching(/nonresumable/),
		});
		await expect(reviveWorker(entry, ID)).rejects.toThrow(/transcript cannot be resumed/);
		expect(AgentRegistry.global().get(ID)?.status).toBe("aborted");
	});
});
