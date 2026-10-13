/**
 * Behavioral proof for the advertised `capabilities` map: a real daemon is
 * spawned on a real cwd, a fresh `/events` attach is opened, and the `state`
 * frame that the attach priming carries is inspected. Git availability is a
 * runtime fact about the session cwd, so the same daemon build must answer
 * differently for a repository and for a plain directory.
 */
import { afterAll, expect, test } from "bun:test";
import path from "node:path";
import type { Subprocess } from "bun";
import {
	OMP_SESSION_PREFIX,
	type StdoutContractLine,
	type WebSessionState,
} from "#lib/wire/protocol";
import { parseSseUnits } from "#lib/wire/sse";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";

afterAll(cleanupTempDirs);

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const children: Subprocess[] = [];

afterAll(() => {
	for (const child of children) child.kill();
});

/** A `state` SSE frame as the daemon serializes it. */
type StateFrame = { type?: string; state?: WebSessionState };

/**
 * Capability keys the UI depends on, in the daemon's `capabilities` map. The
 * protocol is additive (a new capability is a new key), so the assertion below
 * requires these and tolerates anything the daemon adds.
 */
const REQUIRED_CAPABILITY_KEYS = [
	"advisor",
	"btwHistory",
	"downloads",
	"git",
	"goals",
	"loops",
	"planReview",
	"resumeImport",
	"review",
	"todos",
	"vibe",
	"workerLifecycle",
] as const;

/** Read stdout up to the first newline and return that line. */
async function firstStdoutLine(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	while (!buffer.includes("\n")) {
		const { value, done } = await reader.read();
		if (done) throw new Error(`daemon exited before its listening line: ${buffer}`);
		buffer += decoder.decode(value, { stream: true });
	}
	reader.releaseLock();
	return buffer.slice(0, buffer.indexOf("\n"));
}

/** Spawn a daemon on `cwd`, attach to /events, and return the first state snapshot. */
async function attachedState(cwd: string): Promise<WebSessionState> {
	const child = Bun.spawn(["bun", "apps/session/index.ts", "--cwd", cwd], {
		cwd: repoRoot,
		env: {
			...process.env,
			OMP_SESSION_PORT: "0",
			PI_NO_TITLE: "1",
			PI_CODING_AGENT_DIR: tempDir("omp-capabilities-agent-"),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	children.push(child);
	const line = await firstStdoutLine(child.stdout as ReadableStream<Uint8Array>);
	expect(line.startsWith(OMP_SESSION_PREFIX)).toBe(true);
	const contract = JSON.parse(line.slice(OMP_SESSION_PREFIX.length)) as StdoutContractLine;
	if (contract.event !== "listening") throw new Error(`unexpected first stdout line: ${line}`);
	const port = contract.port;

	const res = await fetch(`http://127.0.0.1:${port}/events`);
	if (!res.body) throw new Error("/events returned no body");
	try {
		for await (const unit of parseSseUnits(res.body)) {
			if (unit.kind !== "event") continue;
			const frame = JSON.parse(unit.data) as StateFrame;
			if (frame.type === "state" && frame.state) return frame.state;
		}
		throw new Error("/events ended before a state frame");
	} finally {
		await res.body.cancel().catch(() => {});
		child.kill();
	}
}

test("a git cwd advertises git (and the review domains) as available", async () => {
	const repo = tempDir("omp-capabilities-git-");
	await Bun.$`git init -q ${repo}`.quiet();

	const state = await attachedState(repo);

	expect(state.capabilities?.git).toEqual({ available: true });
	// Superset, not an exact key list: the map is additive, so every new
	// capability is a new key. Only the domains the UI requires are pinned;
	// dropping one of them is the drift this asserts against.
	expect(Object.keys(state.capabilities ?? {})).toEqual(
		expect.arrayContaining([...REQUIRED_CAPABILITY_KEYS]),
	);
}, 60_000);

test("a non-git cwd advertises git as unavailable with the reason", async () => {
	const plain = tempDir("omp-capabilities-plain-");

	const state = await attachedState(plain);

	expect(state.capabilities?.git?.available).toBe(false);
	expect(state.capabilities?.git?.reason).toContain("not a git repository");
	// The review domains are cwd-independent, so they stay advertised.
	expect(state.capabilities?.review).toEqual({ available: true });
}, 60_000);
