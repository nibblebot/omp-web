/**
 * Behavioral proof for the advertised `capabilities` map: a real daemon is
 * spawned on a real cwd, a fresh browser-socket (`/ws`) attach is opened, and
 * the `state` frame that the attach priming carries is inspected. Git availability is a
 * runtime fact about the session cwd, so the same daemon build must answer
 * differently for a repository and for a plain directory.
 */
import { afterAll, expect, test } from "bun:test";
import path from "node:path";
import type { Subprocess } from "bun";
import {
	OMP_PROTO,
	OMP_SESSION_PREFIX,
	type StdoutContractLine,
	type WebSessionState,
} from "#lib/wire/protocol";
import { browserSocketUrl, parseServerMessage } from "#lib/wire/browser-socket";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";

afterAll(cleanupTempDirs);

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const children: Subprocess[] = [];

afterAll(() => {
	for (const child of children) child.kill();
});

/** A `state` frame as the daemon serializes it. */
type StateFrame = { type?: string; state?: WebSessionState };

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

/** Spawn a daemon on `cwd`, attach to /ws, and return the first state snapshot. */
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

	const url = browserSocketUrl(`http://127.0.0.1:${port}`, {
		clientId: null,
		after: null,
		proto: OMP_PROTO,
		token: null,
	});
	const socket = new WebSocket(url);
	try {
		return await new Promise<WebSessionState>((resolve, reject) => {
			socket.addEventListener("message", (event) => {
				const message = parseServerMessage(event.data);
				if (message?.kind !== "frame") return;
				const frame = message.frame as unknown as StateFrame;
				if (frame.type === "state" && frame.state) resolve(frame.state);
			});
			socket.addEventListener("error", () =>
				reject(new Error(`browser socket dial failed: ${url}`)),
			);
			socket.addEventListener("close", () => reject(new Error("/ws closed before a state frame")));
		});
	} finally {
		socket.close();
		child.kill();
	}
}

test("a git cwd advertises git as available", async () => {
	const repo = tempDir("omp-capabilities-git-");
	await Bun.$`git init -q ${repo}`.quiet();

	const state = await attachedState(repo);

	expect(state.capabilities?.git).toEqual({ available: true });
}, 60_000);

test("a non-git cwd advertises git as unavailable with the reason", async () => {
	const plain = tempDir("omp-capabilities-plain-");

	const state = await attachedState(plain);

	expect(state.capabilities?.git?.available).toBe(false);
	expect(state.capabilities?.git?.reason).toContain("not a git repository");
}, 60_000);
