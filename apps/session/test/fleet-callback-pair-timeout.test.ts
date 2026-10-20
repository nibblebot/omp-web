/**
 * Regression (kata w622): Bun's fetch aborted the session's callback legs
 * (POST /callback/up with a streaming body, GET /callback/down SSE) after its
 * default timeout even while heartbeats flowed, cutting every pair every
 * 360 s. FleetCallback now passes `timeout: false` on both legs.
 *
 * The timeout is Bun's native HTTP client timer, so fake timers cannot
 * reproduce it. Bun reads BUN_CONFIG_HTTP_IDLE_TIMEOUT (seconds) at process
 * start, so a child `bun` started with it set to 1 s cuts a default-timeout
 * fetch at ~8 s. The child (fleet-callback-pair-timeout.testkit.ts) holds a
 * real FleetCallback pair against a real DaemonTransportRegistry for longer
 * than that and reports whether the pair was ever replaced.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const HARNESS = resolve(import.meta.dir, "fleet-callback-pair-timeout.testkit.ts");
/** Longer than the ~8 s a default-timeout fetch survives with the 1 s idle setting. */
const HOLD_MS = 12_000;
const HEARTBEAT_MS = 500;

interface HarnessReport {
	readyConnectionId: string | null;
	finalConnectionId: string | null;
	connectionIds: string[];
	state: string;
	readyCount: number;
	reconnects: number;
	renewals: number;
	lastError: { code: string; message: string; at: number } | null;
	errors: string[];
}

const children: Subprocess[] = [];
afterAll(() => {
	for (const child of children) child.kill("SIGKILL");
});

async function runHarness(): Promise<{ report: HarnessReport; stderr: string }> {
	const child = Bun.spawn([process.execPath, HARNESS, String(HOLD_MS), String(HEARTBEAT_MS)], {
		cwd: REPO_ROOT,
		env: { ...process.env, BUN_CONFIG_HTTP_IDLE_TIMEOUT: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	children.push(child);
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (code !== 0) throw new Error(`harness exited ${code}: ${stderr}\n${stdout}`);
		return { report: JSON.parse(stdout.trim().split("\n").pop() ?? "") as HarnessReport, stderr };
	} finally {
		child.kill("SIGKILL");
	}
}

describe("FleetCallback pair under Bun's fetch timeout", () => {
	test("a heartbeating pair survives past the default fetch timeout without a replacement", async () => {
		const { report } = await runHarness();

		expect(report.errors).toEqual([]);
		expect(report.lastError).toBeNull();
		expect(report.reconnects).toBe(0);
		expect(report.renewals).toBe(0);
		expect(report.readyCount).toBe(1);
		expect(report.state).toBe("ready");
		expect(report.readyConnectionId).not.toBeNull();
		expect(report.finalConnectionId).toBe(report.readyConnectionId!);
		expect(report.connectionIds).toEqual([report.readyConnectionId!]);
	}, 25_000);
});
