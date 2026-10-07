#!/usr/bin/env bun
/**
 * Boots a real omp-session daemon from a checkout against the operator's own
 * SDK config (agent dir, auth, models) and reads its /events priming through
 * `ready`. This exercises in-process SDK session creation with real settings,
 * which the hermetic test suites deliberately avoid.
 *
 *   bun .omp/skills/sdk-reconcile/smoke-daemon.ts [--root <checkout>] [--timeout-ms 60000]
 *
 * Prints one JSON line on stdout: { ok, sdkModel, frames, sessionFile, ... }.
 * Exit 0 only when hello_ok, state, and ready all arrived. The daemon is bound
 * to a fresh temp dir, never the checkout, and is killed before exit.
 */
import { mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? undefined : process.argv[index + 1];
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: undefined;
}

const root = resolve(arg("root") ?? process.cwd());
const timeoutMs = Number(arg("timeout-ms") ?? 60_000);
const cwd = mkdtempSync(join(tmpdir(), "omp-sdk-smoke-"));

const child = Bun.spawn(
	["bun", join(root, "apps/session/index.ts"), "--cwd", cwd, "--port", "0", "--idle-timeout", "0"],
	{ cwd: root, stdout: "pipe", stderr: "pipe" },
);
let stderr = "";
void (async () => {
	for await (const chunk of child.stderr.pipeThrough(new TextDecoderStream())) stderr += chunk;
})();

const frames: string[] = [];
const result: Record<string, unknown> = { ok: false, frames };
const deadline = AbortSignal.timeout(timeoutMs);

try {
	let base: string | undefined;
	let buffered = "";
	for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
		buffered += chunk;
		const line = buffered.split("\n").find((l) => l.startsWith("OMP_SESSION|"));
		if (line === undefined) continue;
		const contract = record(JSON.parse(line.slice("OMP_SESSION|".length)));
		if (contract?.event === "listening") {
			base = `http://${String(contract.bind)}:${String(contract.port)}`;
			break;
		}
	}
	if (base === undefined)
		throw new Error("daemon exited before printing its OMP_SESSION| listening line");

	const response = await fetch(`${base}/events`, { signal: deadline });
	if (!response.ok || response.body === null)
		throw new Error(`/events answered ${response.status}`);
	let pending = "";
	streamLoop: for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
		pending += chunk;
		const units = pending.split("\n\n");
		pending = units.pop() ?? "";
		for (const unit of units) {
			const data = unit
				.split("\n")
				.filter((l) => l.startsWith("data:"))
				.map((l) => l.slice(5).trimStart())
				.join("\n");
			if (data === "") continue;
			const frame = record(JSON.parse(data));
			const type = typeof frame?.type === "string" ? frame.type : "?";
			frames.push(type);
			if (type === "hello_ok") {
				result.proto = frame?.proto;
				result.version = frame?.version;
				result.sessionFile = frame?.sessionFile;
			} else if (type === "state") {
				const model = record(record(frame?.state)?.model);
				result.sdkModel =
					model === undefined ? null : `${String(model.provider)}/${String(model.id)}`;
			} else if (type === "ready") {
				break streamLoop;
			}
		}
	}
	const missing = ["hello_ok", "state", "ready"].filter((t) => !frames.includes(t));
	if (missing.length > 0) throw new Error(`stream ended without: ${missing.join(", ")}`);
	result.ok = true;
} catch (error) {
	result.error = error instanceof Error ? error.message : String(error);
} finally {
	child.kill("SIGTERM");
	const exited = await Promise.race([child.exited, Bun.sleep(5_000).then(() => null)]);
	if (exited === null) child.kill("SIGKILL");
	rmSync(cwd, { recursive: true, force: true });
	// The SDK creates a per-cwd sessions dir; a messageless boot leaves it empty.
	// rmdirSync refuses non-empty dirs, so a session that did persist is kept.
	if (typeof result.sessionFile === "string") {
		try {
			rmdirSync(dirname(result.sessionFile));
		} catch {}
	}
}

if (!result.ok) result.stderrTail = stderr.split("\n").slice(-40).join("\n");
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
