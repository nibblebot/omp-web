/**
 * kx3w regression: log_ack names only group-committed (durable) offsets. A
 * failed commit withholds the ack for the batch; the next chunk after the
 * fault clears acks up to the full durable length.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs } from "#lib/testkit/temp-dir.testkit";
import { CALLBACK_TRANSPORT_STREAM_ID } from "#lib/wire/callback-protocol";
import type { FleetLogStore } from "../log-store";
import { Registry } from "../registry";
import type { FleetServer } from "../server";
import { type CallbackSession, startCallbackSession } from "./callback-session.testkit";
import { fleetPaths, pinSettingsInMemory, startTestFleet, waitFor } from "./server.testkit";

afterAll(cleanupTempDirs);

// Pin the process-global Settings singleton in-memory (see the testkit).
await pinSettingsInMemory();

const SEEDED_WORKSPACES = ["ack-ok", "ack-blocked"];

interface SeededWorkspace {
	workspaceId: string;
	credential: string;
	generation: number;
}

/** Every log_ack offsets map the session received on the reserved stream. */
function ackOffsets(session: CallbackSession): Array<Record<string, number>> {
	return session.received().flatMap((envelope) => {
		if (envelope.kind !== "control" || envelope.streamId !== CALLBACK_TRANSPORT_STREAM_ID) {
			return [];
		}
		const payload = envelope.payload as { type?: unknown; offsets?: Record<string, number> };
		return payload.type === "log_ack" && payload.offsets !== undefined ? [payload.offsets] : [];
	});
}

describe("fleet log_ack durability (kx3w)", () => {
	let server: FleetServer;
	const sessions: CallbackSession[] = [];
	const seeded = new Map<string, SeededWorkspace>();

	beforeAll(async () => {
		const { statePath, configPath } = fleetPaths();
		const registry = new Registry(statePath);
		await registry.load();
		for (const name of SEEDED_WORKSPACES) {
			const credential = randomBytes(32).toString("hex");
			const entry = registry.create({
				name,
				cwd: "",
				project: "",
				status: "asleep",
			});
			registry.updateWorkspace(entry.workspaceId, { desiredState: "stopped" });
			registry.setWorkspaceEnrollment(entry.workspaceId, {
				credentialHash: createHash("sha256").update(Buffer.from(credential, "hex")).digest("hex"),
				generation: 1,
			});
			seeded.set(name, { workspaceId: entry.workspaceId, credential, generation: 1 });
		}
		registry.flush();
		server = await startTestFleet(
			{ statePath, configPath },
			{},
			{ settings: { registry: async () => [] } },
		);
		expect(server.logStore).not.toBeNull();
	});

	afterAll(async () => {
		for (const session of sessions) await session.stop();
		sessions.length = 0;
		if (server !== undefined) await server.close();
	});

	function store(): FleetLogStore {
		const loaded = server.logStore;
		if (loaded === null) throw new Error("fleet log store unavailable in the test fleet");
		return loaded;
	}

	async function pair(name: string): Promise<{ workspaceId: string; session: CallbackSession }> {
		const seed = seeded.get(name);
		if (seed === undefined) throw new Error(`workspace ${name} was not seeded before boot`);
		const session = startCallbackSession({
			url: `http://127.0.0.1:${server.port}`,
			workspaceId: seed.workspaceId,
			generation: seed.generation,
			token: seed.credential,
		});
		sessions.push(session);
		await session.waitConnected();
		return { workspaceId: seed.workspaceId, session };
	}

	function sendFrame(
		session: CallbackSession,
		streamId: string,
		offset: number,
		content: string,
	): void {
		session.send(streamId, "frame", {
			offset,
			generation: 1,
			data: Buffer.from(content, "utf8").toString("base64"),
			eof: false,
		});
	}

	test("log_ack carries the durable offset once the batch is committed", async () => {
		const { workspaceId, session } = await pair("ack-ok");
		const streamId = "logs/sess-ok/sess-ok.jsonl";
		const content = '{"type":"message","id":"ok-1"}\n';
		sendFrame(session, streamId, 0, content);
		await waitFor(
			() => ackOffsets(session).some((offsets) => offsets[streamId] === content.length),
			5000,
			"log_ack for ok stream",
		);
		const onDisk = readFileSync(join(store().rootDir, workspaceId, "sess-ok", "sess-ok.jsonl"));
		expect(onDisk.equals(Buffer.from(content, "utf8"))).toBe(true);
	});

	test("a failed group commit withholds the ack; the next chunk acks the full durable length", async () => {
		const { workspaceId, session } = await pair("ack-blocked");
		const streamId = "logs/sess-blk/sess-blk.jsonl";
		const first = '{"type":"message","id":"blk-1"}\n';
		const second = '{"type":"message","id":"blk-2"}\n';
		const third = '{"type":"message","id":"blk-3"}\n';

		// Clean frame first: creates the session and its index.json, so the
		// next commit is an ordinary append batch rather than a new session.
		sendFrame(session, streamId, 0, first);
		await waitFor(
			() => ackOffsets(session).some((offsets) => offsets[streamId] === first.length),
			5000,
			"log_ack for first frame",
		);

		// A directory where the index temp file must go makes commit() throw.
		const blocker = join(store().rootDir, workspaceId, "sess-blk", "index.json.tmp");
		mkdirSync(blocker, { recursive: true });
		const logged: string[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => {
			logged.push(args.map(String).join(" "));
		};
		try {
			sendFrame(session, streamId, first.length, second);
			await waitFor(
				() => logged.some((line) => line.includes("log commit failed")),
				5000,
				"failed group commit",
			);
		} finally {
			console.error = original;
		}
		// The batch containing `second` must not be acked.
		expect(ackOffsets(session).some((offsets) => (offsets[streamId] ?? 0) > first.length)).toBe(
			false,
		);

		rmSync(blocker, { recursive: true, force: true });
		sendFrame(session, streamId, first.length + second.length, third);
		const total = first.length + second.length + third.length;
		await waitFor(
			() => ackOffsets(session).some((offsets) => offsets[streamId] === total),
			5000,
			"log_ack after recovery",
		);
		const onDisk = readFileSync(join(store().rootDir, workspaceId, "sess-blk", "sess-blk.jsonl"));
		expect(onDisk.equals(Buffer.from(first + second + third, "utf8"))).toBe(true);
	});
});
