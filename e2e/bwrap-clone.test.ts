/**
 * Cross-app E2E: a bwrap-sandboxed clone pairs with a real fleet over the
 * WebSocket callback pair (`GET /callback/ws`, OMP_CALLBACK_PROTO 2).
 *
 * Boots a real fleet (startFleet) on a loopback port with a tmp state dir and a
 * `bwrap` provider profile (`network: "host"`, the loopback-HTTP developer
 * exception, so the sandbox can dial the fleet's loopback callback URL), and a
 * fake OpenAI-compatible model (scripts/profile/fake-model) written into the
 * clone's private agent dir, so the sandbox never touches operator state or a
 * live model. A real `omp-session` then runs inside the bwrap sandbox, launched
 * by the real bwrap provider executable, and:
 *  1. the session's pair reaches ready (the fleet holds a live pair with a
 *     connectionId, which only the WebSocket pair mints) and its first envelope
 *     (`pair_ready`) was delivered;
 *  2. a prompt round trips through the pair to the fake model and its streamed
 *     answer comes back;
 *  3. stop ends the sandbox and parks the row asleep, start resumes it under a
 *     new generation with a fresh pair, and a prompt works on the resumed session.
 *
 * Skipped (not failed) where bubblewrap cannot create a user namespace, the same
 * probe `omp-web preflight` runs (`bwrap-userns`). Every process the suite
 * starts is tracked by its tmp root and killed in afterAll.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { RosterEntry } from "#lib/wire/protocol";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { startFakeModel, type FakeModel } from "../scripts/profile/fake-model/server";
import { writeAgentDir } from "../scripts/profile/fake-model/config";
import { textTurn } from "../scripts/profile/fake-model/directives";
import { type FleetServer, startFleet } from "../apps/fleet/server";
import { hermeticStatsConfig } from "./helpers.testkit";

afterAll(cleanupTempDirs);

const BWRAP = Bun.which("bwrap");
const GIT = Bun.which("git");
const BWRAP_PROVIDER = join(process.cwd(), "apps/fleet/bwrap-provider.ts");

/** True when bubblewrap can run a command in a user namespace here (the `bwrap-userns` preflight probe). */
function bwrapUsable(): boolean {
	if (process.platform !== "linux" || BWRAP === null || GIT === null) return false;
	const probe = Bun.spawnSync([BWRAP, "--ro-bind", "/", "/", "--", "echo", "ok"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return probe.exitCode === 0;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Host pids whose argv names `root` (the sandboxed session and its bwrap/supervisor parents). */
function procsNaming(root: string): number[] {
	const pids: number[] = [];
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
		try {
			if (readFileSync(`/proc/${name}/cmdline`, "utf8").includes(root)) pids.push(Number(name));
		} catch {
			// exited between readdir and read
		}
	}
	return pids;
}

interface PromptResultWire {
	workspaceId: string;
	ok: boolean;
	text?: string;
	error?: string;
}

describe.skipIf(!bwrapUsable())("e2e: bwrap clone pairs over the WebSocket callback", () => {
	let tmp: string;
	let server!: FleetServer;
	let model!: FakeModel;
	let entry!: RosterEntry;
	const savedFleetEnv: Record<string, string | undefined> = {};

	const base = (): string => `http://127.0.0.1:${server.port}`;
	const postJson = (path: string, body: unknown): Promise<Response> =>
		fetch(`${base()}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});

	async function getEntry(): Promise<RosterEntry | undefined> {
		const res = await fetch(`${base()}/ctl/sessions`);
		const entries = (await res.json()) as RosterEntry[];
		return entries.find((row) => row.workspaceId === entry.workspaceId);
	}

	async function waitForEntry(
		predicate: (row: RosterEntry) => boolean,
		timeoutMs: number,
		what: string,
	): Promise<RosterEntry> {
		const deadline = Date.now() + timeoutMs;
		let last: RosterEntry | undefined;
		while (Date.now() < deadline) {
			last = await getEntry();
			if (last !== undefined) {
				if (predicate(last)) return last;
				if (last.status === "error") {
					const tail = server.lifecycle.sessionLogTail(entry.workspaceId);
					throw new Error(
						`clone entered error: ${last.error ?? "unknown"}\nlog tail: ${tail ?? ""}`,
					);
				}
			}
			await sleep(60);
		}
		const tail = server.lifecycle.sessionLogTail(entry.workspaceId);
		throw new Error(
			`timed out waiting for the clone to ${what} (${timeoutMs}ms); last status ${last?.status ?? "absent"}\nlog tail: ${tail ?? ""}`,
		);
	}

	/** A prompt through POST /ctl/prompt; the fake model streams `chars` characters back. */
	async function prompt(chars: number): Promise<PromptResultWire> {
		const text = textTurn({ route: entry.workspaceId, chars, chunkChars: 16, deltasPerSec: 0 });
		const res = await postJson("/ctl/prompt", {
			selector: entry.workspaceId,
			text,
			waitMs: 60_000,
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as PromptResultWire[];
		expect(body).toHaveLength(1);
		return body[0]!;
	}

	/** The one live pair the fleet holds for the clone, with proof it is a WebSocket pair. */
	function livePair(): { connectionId: string; envelopes: number } {
		const status = server.transport.pairStatus(entry.workspaceId);
		expect(status.paired).toBe(true);
		expect(status.connectionId).not.toBeNull();
		return { connectionId: status.connectionId!, envelopes: status.envelopesReceived };
	}

	beforeAll(async () => {
		tmp = tempDir("omp-web-bwrap-clone-");
		const statePath = join(tmp, "state.json");
		const configPath = join(tmp, "config.json");
		const modelRoot = join(tmp, "model");
		mkdirSync(modelRoot, { recursive: true });
		model = await startFakeModel({ sendLog: join(modelRoot, "send.ndjson") });
		writeFileSync(
			configPath,
			JSON.stringify({
				providerProfiles: {
					sandbox: {
						provider: "bwrap",
						executable: BWRAP_PROVIDER,
						// bwrap cannot mount on a symlink destination (NixOS links git into a profile).
						tools: [realpathSync(GIT!)],
						network: "host",
					},
				},
			}),
		);
		// OMP_FLEET_* env replaces config outright (config.ts); keep the suite hermetic.
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("OMP_FLEET_")) {
				savedFleetEnv[key] = process.env[key];
				delete process.env[key];
			}
		}
		server = await startFleet({
			port: 0,
			statePath,
			configPath,
			workspaceDir: join(tmp, "workspaces"),
			statsConfig: hermeticStatsConfig(statePath),
		});
	});

	afterAll(async () => {
		for (const [key, value] of Object.entries(savedFleetEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		if (entry !== undefined && server !== undefined) {
			await postJson("/ctl/stop", { selector: entry.workspaceId }).catch(() => undefined);
		}
		if (server !== undefined) await server.close();
		if (model !== undefined) await model.close();
		if (tmp === undefined) return;
		for (const pid of procsNaming(tmp)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// gone
			}
		}
	});

	test("create a bwrap clone with a fake-model agent dir, start it: the pair reaches ready over /callback/ws", async () => {
		const source = join(tmp, "source");
		mkdirSync(source, { recursive: true });
		const git = (...args: string[]): void => {
			const proc = Bun.spawnSync([GIT!, "-C", source, ...args], { stderr: "pipe" });
			if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
		};
		git("init", "-q", "-b", "main");
		writeFileSync(join(source, "readme.md"), "hello\n");
		git("add", ".");
		git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");

		const registered = await postJson("/ctl/projects", { path: source });
		expect(registered.status).toBe(201);
		const { project } = (await registered.json()) as { project: { projectId: string } };
		const created = await postJson("/ctl/clones", {
			projectId: project.projectId,
			name: "sandboxed",
			profileId: "sandbox",
			start: false,
		});
		expect(created.status).toBe(201);
		entry = ((await created.json()) as { entry: RosterEntry }).entry;

		// The clone's private home lives in its volume; point its agent dir at the fake model.
		const state = JSON.parse(readFileSync(join(tmp, "state.json"), "utf8")) as {
			entries: Array<{ workspaceId: string; cwd?: string }>;
		};
		const volume = state.entries.find((row) => row.workspaceId === entry.workspaceId)!.cwd!;
		const agentDir = join(volume, ".home", "agent");
		mkdirSync(agentDir, { recursive: true });
		await writeAgentDir(agentDir, model.url);

		const started = await postJson("/ctl/start", { workspaceId: entry.workspaceId });
		expect(started.status).toBe(200);
		await waitForEntry(
			(row) => row.status === "ready" && row.lifecycleStage === "ready",
			90_000,
			"become ready",
		);

		const pair = livePair();
		// pair_ready is the fleet's first envelope; the session's own envelopes followed.
		expect(pair.connectionId).toMatch(/^[0-9a-f-]{36}$/);
		expect(pair.envelopes).toBeGreaterThan(0);
		// The session runs inside bubblewrap: a bwrap parent names the workspace volume.
		const sandboxed = procsNaming(volume).some((pid) =>
			readFileSync(`/proc/${pid}/cmdline`, "utf8")
				.split("\0")
				.some((arg) => arg.endsWith("bwrap")),
		);
		expect(sandboxed).toBe(true);
	}, 150_000);

	test("a prompt round trips through the pair to the fake model and back", async () => {
		const result = await prompt(2_000);
		expect(result.error).toBeUndefined();
		expect(result.ok).toBe(true);
		expect((result.text ?? "").length).toBeGreaterThan(0);
	}, 90_000);

	test("stop ends the sandbox; start resumes under a new generation with a fresh pair and a prompt works", async () => {
		const first = livePair();
		const sessionFile = (await getEntry())?.lastSessionFile;
		expect(sessionFile).toBeDefined();
		const generationBefore = server.transport.pairStatus(entry.workspaceId).authorizedGeneration;
		const stopped = await postJson("/ctl/stop", { selector: entry.workspaceId });
		expect(stopped.status).toBe(200);
		await waitForEntry((row) => row.status === "asleep", 60_000, "park asleep");
		expect(server.transport.pairStatus(entry.workspaceId).paired).toBe(false);

		const restarted = await postJson("/ctl/start", { workspaceId: entry.workspaceId });
		expect(restarted.status).toBe(200);
		await waitForEntry(
			(row) => row.status === "ready" && row.lifecycleStage === "ready",
			90_000,
			"become ready again",
		);
		const second = livePair();
		// Wake resumed the same session transcript instead of starting a new one.
		expect((await getEntry())?.lastSessionFile).toBe(sessionFile);
		expect(second.connectionId).not.toBe(first.connectionId);
		expect(server.transport.pairStatus(entry.workspaceId).authorizedGeneration).toBeGreaterThan(
			generationBefore ?? 0,
		);
		const result = await prompt(1_000);
		expect(result.ok).toBe(true);
		expect(existsSync(join(tmp, "state.json"))).toBe(true);
	}, 240_000);
});
