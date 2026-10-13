/**
 * P7.6 log retention on the fleet control plane (apps/fleet/server.ts):
 *   - the daemon's additive `session_deleted` control notice purges that
 *     session's fleet copy (the workspace wins), is refused on a verified
 *     read-only workspace, and ignores an empty/non-string sessionId;
 *   - GET /ctl/logs/orphans flags store-orphaned subtrees, and only those;
 *   - POST /ctl/logs/purge refuses a live writable workspace and otherwise
 *     removes the bytes and clears the storeOrphan marker.
 *
 * The notice is driven over a REAL callback pair (startCallbackDaemon)
 * against an enrollment minted by POST /ctl/enroll (which attaches the
 * fleet's per-workspace log tap): the control envelope rides the HTTP up-leg
 * on the reserved `transport` stream — exactly where the fleet's own
 * `log_ack` controls go — into transport → tap → #onLogEnvelope. No private
 * method is called directly; only the read-only flip the clone delete gate
 * would perform is store-level setup.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CALLBACK_TRANSPORT_STREAM_ID, type CallbackEnvelope } from "#lib/wire/callback-protocol";
import type { FleetLogStore } from "../log-store";
import type { FleetServer } from "../server";
import { type CallbackDaemon, startCallbackDaemon } from "./callback-daemon.testkit";
import {
	cleanupTempDirs,
	fleetPaths,
	pinSettingsInMemory,
	postJson,
	startTestFleet,
	waitFor,
} from "./server.testkit";

// bun 1.3.14 attributes afterAll hooks registered in imported modules to the
// first importer only; register cleanup in this file's own module scope.
afterAll(cleanupTempDirs);

// Pin the process-global Settings singleton in-memory (see the testkit).
await pinSettingsInMemory();

/** Complete-line JSONL bodies, as the daemon streams closed session files. */
const MAIN_CONTENT = '{"type":"session","id":"s1"}\n{"type":"message","id":"m1"}\n';
const SUBAGENT_CONTENT = '{"type":"session","id":"s1-sub"}\n{"type":"message","id":"m2"}\n';
const SIBLING_CONTENT = '{"type":"session","id":"s2"}\n';

describe("fleet log retention routes (P7.6)", () => {
	let statePath: string;
	let configPath: string;
	let server: FleetServer;
	const daemons: CallbackDaemon[] = [];
	const unwatch: Array<() => void> = [];

	beforeAll(async () => {
		({ statePath, configPath } = fleetPaths());
		server = await startTestFleet(
			{ statePath, configPath },
			{},
			// Stub the settings provider registry: the default lazily opens
			// the real ~/.omp auth DB, which these tests must not touch.
			{ settings: { registry: async () => [] } },
		);
		expect(server.logStore).not.toBeNull();
	});

	afterAll(async () => {
		for (const stop of unwatch) stop();
		unwatch.length = 0;
		for (const daemon of daemons) await daemon.stop();
		daemons.length = 0;
		if (server !== undefined) await server.close();
	});

	/** The booted fleet's log store (asserted non-null in beforeAll). */
	function store(): FleetLogStore {
		const loaded = server.logStore;
		if (loaded === null) throw new Error("fleet log store unavailable in the test fleet");
		return loaded;
	}

	/** Fleet-side session dir: logs/<workspaceId>/<sessionId>. */
	function sessionDir(workspaceId: string, sessionId: string): string {
		return join(store().rootDir, workspaceId, sessionId);
	}

	interface PairedWorkspace {
		workspaceId: string;
		daemon: CallbackDaemon;
		/** Every daemon->fleet envelope the fleet dispatched for this workspace. */
		seen: CallbackEnvelope[];
	}

	/**
	 * POST /ctl/enroll (creates the remote roster entry and attaches the
	 * fleet's log tap), then dial the real callback pair with the minted
	 * credential. A witness tap is registered AFTER the fleet's (the enroll
	 * route attaches it before responding) so insertion-ordered tap dispatch
	 * runs the log tap first: observing an envelope here proves
	 * #onLogEnvelope already ran it, without sleeping on a negative.
	 */
	async function enrollAndPair(name: string): Promise<PairedWorkspace> {
		const res = await postJson(server.port, "/ctl/enroll", { name });
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			enrollment: { workspaceId: string; generation: number; token: string };
		};
		const enrollment = body.enrollment;
		const daemon = startCallbackDaemon({
			url: `http://127.0.0.1:${server.port}`,
			workspaceId: enrollment.workspaceId,
			generation: enrollment.generation,
			token: enrollment.token,
		});
		daemons.push(daemon);
		await daemon.waitConnected();
		const seen: CallbackEnvelope[] = [];
		unwatch.push(
			server.transport.onDaemonEnvelope(enrollment.workspaceId, (envelope) => {
				seen.push(envelope);
			}),
		);
		return { workspaceId: enrollment.workspaceId, daemon, seen };
	}

	/**
	 * Stream one complete (eof) file as the daemon does — streamId
	 * `logs/<sessionId>/<relpath>`, LogChunk payload — and wait until the
	 * durable bytes are readable.
	 */
	async function storeStream(
		workspace: PairedWorkspace,
		sessionId: string,
		relpath: string,
		content: string,
	): Promise<void> {
		const bytes = Buffer.from(content, "utf8");
		workspace.daemon.send(`logs/${sessionId}/${relpath}`, "frame", {
			offset: 0,
			generation: 1,
			data: bytes.toString("base64"),
			eof: true,
		});
		const file = join(sessionDir(workspace.workspaceId, sessionId), relpath);
		await waitFor(
			() => {
				try {
					return readFileSync(file).equals(bytes);
				} catch {
					return false;
				}
			},
			5000,
			`stored ${sessionId}/${relpath}`,
		);
	}

	/** The daemon's additive session-deletion notice on the reserved stream. */
	function isSessionDeletedNotice(envelope: CallbackEnvelope): boolean {
		if (envelope.kind !== "control" || envelope.streamId !== CALLBACK_TRANSPORT_STREAM_ID) {
			return false;
		}
		const payload: unknown = envelope.payload;
		return (
			typeof payload === "object" &&
			payload !== null &&
			"type" in payload &&
			payload.type === "session_deleted"
		);
	}

	interface OrphanRow {
		workspaceId: string;
		sessions: string[];
		readOnly: boolean;
		bytes: number;
		storeOrphan: boolean;
	}

	async function listOrphans(): Promise<OrphanRow[]> {
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/logs/orphans`);
		expect(res.status).toBe(200);
		// Route-owned shape; the tests assert the fields they depend on.
		const body = (await res.json()) as { orphans: OrphanRow[] };
		return body.orphans;
	}

	/** Store one session, then evict the entry through POST /ctl/remove. */
	async function orphanThroughRemoveRoute(name: string, sessionId: string): Promise<string> {
		const workspace = await enrollAndPair(name);
		await storeStream(workspace, sessionId, `${sessionId}.jsonl`, MAIN_CONTENT);
		await workspace.daemon.stop();
		const res = await postJson(server.port, "/ctl/remove", { selector: workspace.workspaceId });
		expect(res.status).toBe(200);
		return workspace.workspaceId;
	}

	describe("session_deleted control notice", () => {
		test("purges the fleet copy of that session and keeps its siblings", async () => {
			const workspace = await enrollAndPair("del-purge");
			await storeStream(workspace, "sess-a", "sess-a.jsonl", MAIN_CONTENT);
			await storeStream(workspace, "sess-a", "sess-a/sub-1.jsonl", SUBAGENT_CONTENT);
			await storeStream(workspace, "sess-b", "sess-b.jsonl", SIBLING_CONTENT);

			// The daemon's additive deletion notice (workspace wins).
			workspace.daemon.send(CALLBACK_TRANSPORT_STREAM_ID, "control", {
				type: "session_deleted",
				sessionId: "sess-a",
			});
			await waitFor(
				() => !existsSync(sessionDir(workspace.workspaceId, "sess-a")),
				5000,
				"session subtree purged",
			);

			expect(store().storedSessionDir(workspace.workspaceId, "sess-a")).toBeNull();
			// Session-scoped: the sibling session's bytes are untouched.
			expect(
				readFileSync(join(sessionDir(workspace.workspaceId, "sess-b"), "sess-b.jsonl"), "utf8"),
			).toBe(SIBLING_CONTENT);
		});

		test("is refused on a verified read-only workspace", async () => {
			const workspace = await enrollAndPair("del-readonly");
			await storeStream(workspace, "sess-ro", "sess-ro.jsonl", MAIN_CONTENT);
			// The verified flip the clone delete gate performs after a passed
			// verification; the store's own refusal is what this covers.
			store().markWorkspaceReadOnly(workspace.workspaceId);
			expect(store().isReadOnly(workspace.workspaceId)).toBe(true);

			workspace.daemon.send(CALLBACK_TRANSPORT_STREAM_ID, "control", {
				type: "session_deleted",
				sessionId: "sess-ro",
			});
			await waitFor(
				() => workspace.seen.filter(isSessionDeletedNotice).length >= 1,
				5000,
				"session_deleted dispatched to the fleet tap",
			);

			expect(store().storedSessionDir(workspace.workspaceId, "sess-ro")).not.toBeNull();
			expect(
				readFileSync(join(sessionDir(workspace.workspaceId, "sess-ro"), "sess-ro.jsonl"), "utf8"),
			).toBe(MAIN_CONTENT);
		});

		test("ignores an empty or non-string sessionId", async () => {
			const workspace = await enrollAndPair("del-bad-id");
			await storeStream(workspace, "sess-keep", "sess-keep.jsonl", MAIN_CONTENT);
			const dir = sessionDir(workspace.workspaceId, "sess-keep");

			// Missing, empty, non-string (early return), and an unsafe string
			// (the store's invalid_id refusal is swallowed by the tap).
			const payloads: unknown[] = [
				{ type: "session_deleted" },
				{ type: "session_deleted", sessionId: "" },
				{ type: "session_deleted", sessionId: 7 },
				{ type: "session_deleted", sessionId: "../escape" },
			];
			for (const payload of payloads) {
				workspace.daemon.send(CALLBACK_TRANSPORT_STREAM_ID, "control", payload);
			}
			await waitFor(
				() => workspace.seen.filter(isSessionDeletedNotice).length >= payloads.length,
				5000,
				"session_deleted dispatches",
			);

			expect(existsSync(dir)).toBe(true);
			expect(readFileSync(join(dir, "sess-keep.jsonl"), "utf8")).toBe(MAIN_CONTENT);
			// No throw broke the connection or its tap: a later chunk lands.
			await storeStream(workspace, "sess-after", "sess-after.jsonl", SIBLING_CONTENT);
		});
	});

	describe("GET /ctl/logs/orphans", () => {
		test("flags a subtree whose workspace was removed without verification", async () => {
			const workspaceId = await orphanThroughRemoveRoute("orphan-marked", "orphan-sess");
			expect(server.registry.storeOrphans()[workspaceId]).toBeDefined();

			const orphan = (await listOrphans()).find((row) => row.workspaceId === workspaceId);
			expect(orphan).toMatchObject({
				workspaceId,
				sessions: ["orphan-sess"],
				readOnly: false,
				storeOrphan: true,
			});
			expect(orphan?.bytes).toBeGreaterThan(0);
		});

		test("does not flag a surviving subtree with no storeOrphan marker", async () => {
			const workspace = await enrollAndPair("orphan-unmarked");
			await storeStream(workspace, "kept-sess", "kept-sess.jsonl", MAIN_CONTENT);
			await workspace.daemon.stop();
			// An eviction that never ran the store-orphan marking: the tree
			// survives, no marker exists.
			expect(server.registry.remove(workspace.workspaceId)).toBe(true);

			const orphan = (await listOrphans()).find((row) => row.workspaceId === workspace.workspaceId);
			expect(orphan).toMatchObject({
				workspaceId: workspace.workspaceId,
				sessions: ["kept-sess"],
				storeOrphan: false,
			});
		});
	});

	describe("POST /ctl/logs/purge", () => {
		test("refuses a live workspace whose store is still writable", async () => {
			const workspace = await enrollAndPair("purge-live");
			await storeStream(workspace, "live-sess", "live-sess.jsonl", MAIN_CONTENT);

			const res = await postJson(server.port, "/ctl/logs/purge", {
				workspaceId: workspace.workspaceId,
			});
			expect(res.status).toBe(409);
			expect(
				readFileSync(
					join(sessionDir(workspace.workspaceId, "live-sess"), "live-sess.jsonl"),
					"utf8",
				),
			).toBe(MAIN_CONTENT);
		});

		test("purges an orphaned workspace's bytes and clears its storeOrphan marker", async () => {
			const workspaceId = await orphanThroughRemoveRoute("purge-orphan", "gone-sess");

			const res = await postJson(server.port, "/ctl/logs/purge", { workspaceId });
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ purged: workspaceId, sessions: 1 });

			expect(existsSync(join(store().rootDir, workspaceId))).toBe(false);
			expect(server.registry.storeOrphans()[workspaceId]).toBeUndefined();
			expect((await listOrphans()).some((row) => row.workspaceId === workspaceId)).toBe(false);
		});

		test("purges a live verified read-only workspace", async () => {
			const workspace = await enrollAndPair("purge-readonly");
			await storeStream(workspace, "ro-sess", "ro-sess.jsonl", MAIN_CONTENT);
			store().markWorkspaceReadOnly(workspace.workspaceId);

			const res = await postJson(server.port, "/ctl/logs/purge", {
				workspaceId: workspace.workspaceId,
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ purged: workspace.workspaceId, sessions: 1 });
			expect(existsSync(join(store().rootDir, workspace.workspaceId))).toBe(false);
		});
	});
});
