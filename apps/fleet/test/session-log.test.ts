import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import {
	LEGACY_PROVIDER_LOG,
	PROVIDER_SESSION_LOG,
	pumpToSessionLog,
	readProviderLogTail,
	removeSessionLog,
	SESSION_LOG_MAX_BYTES,
	SessionLog,
} from "../session-log";

afterAll(cleanupTempDirs);

const CAP = SESSION_LOG_MAX_BYTES;
const HALF_CAP_CHUNK = new Uint8Array(600 * 1024);
const encoder = new TextEncoder();

function logPath(prefix: string): string {
	return join(tempDir(prefix), "d.log");
}

describe("session log retention", () => {
	test("a launch over the cap moves the previous run to .1 and starts fresh", () => {
		const path = logPath("omp-session-log-launch-");
		writeFileSync(path, "x".repeat(CAP + 1));
		const log = new SessionLog(path);
		log.write(encoder.encode("new-run\n"));
		log.close();
		expect(readFileSync(`${path}.1`, "utf8")).toHaveLength(CAP + 1);
		expect(readFileSync(path, "utf8")).toBe("new-run\n");
	});

	test("a run that outgrows the cap rotates mid-run and keeps only two generations", () => {
		const path = logPath("omp-session-log-midrun-");
		const log = new SessionLog(path);
		log.write(HALF_CAP_CHUNK.fill(97)); // "a"
		log.write(HALF_CAP_CHUNK.fill(98)); // "b": rotates "a" to .1
		log.write(HALF_CAP_CHUNK.fill(99)); // "c": rotates "b" to .1, dropping "a"
		log.close();
		expect(readFileSync(`${path}.1`, "utf8")).toBe("b".repeat(HALF_CAP_CHUNK.byteLength));
		expect(readFileSync(path, "utf8")).toBe("c".repeat(HALF_CAP_CHUNK.byteLength));
	});

	test("tailOfRun reports only this run's output, not earlier contents of the file", () => {
		const path = logPath("omp-session-log-scope-");
		writeFileSync(path, "stale-from-earlier-run\n");
		const log = new SessionLog(path);
		expect(log.tailOfRun(1024)).toBe("");
		log.write(encoder.encode("fresh\n"));
		expect(log.tailOfRun(1024)).toBe("fresh");
		log.close();
	});

	test("two pumps share one writer and both streams land in the file", async () => {
		const path = logPath("omp-session-log-pumps-");
		const log = new SessionLog(path);
		const streamOf = (text: string) =>
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(encoder.encode(text));
					controller.close();
				},
			});
		await Promise.all([
			pumpToSessionLog(streamOf("stdout-line\n"), log),
			pumpToSessionLog(streamOf("stderr-line\n"), log),
		]);
		log.close();
		const text = readFileSync(path, "utf8");
		expect(text).toContain("stdout-line\n");
		expect(text).toContain("stderr-line\n");
	});

	test("removeSessionLog deletes the log and its rotated generation, and tolerates missing files", () => {
		const path = logPath("omp-session-log-remove-");
		writeFileSync(path, "current");
		writeFileSync(`${path}.1`, "rotated");
		removeSessionLog(path);
		expect(existsSync(path)).toBe(false);
		expect(existsSync(`${path}.1`)).toBe(false);
		expect(() => removeSessionLog(path)).not.toThrow();
	});
});

describe("provider clone log reader", () => {
	test("reads session.log when it exists, ignoring a stale legacy daemon.log", () => {
		const dir = tempDir("omp-session-log-provider-current-");
		writeFileSync(join(dir, LEGACY_PROVIDER_LOG), "old-run\n");
		writeFileSync(join(dir, PROVIDER_SESSION_LOG), "new-run\n");
		expect(readProviderLogTail(dir, 1024)).toBe("new-run\n");
	});

	test("falls back to daemon.log for a clone whose stateDir predates the rename", () => {
		const dir = tempDir("omp-session-log-provider-legacy-");
		writeFileSync(join(dir, "daemon.log"), "line-1\nline-2\n");
		expect(PROVIDER_SESSION_LOG).toBe("session.log");
		expect(readProviderLogTail(dir, 1024)).toBe("line-1\nline-2\n");
		expect(readProviderLogTail(dir, 7)).toBe("line-2\n");
	});

	test("an existing but empty session.log does not fall back", () => {
		const dir = tempDir("omp-session-log-provider-empty-");
		writeFileSync(join(dir, "daemon.log"), "old\n");
		writeFileSync(join(dir, PROVIDER_SESSION_LOG), "");
		expect(readProviderLogTail(dir, 1024)).toBe("");
	});

	test("is empty when neither log exists", () => {
		expect(readProviderLogTail(tempDir("omp-session-log-provider-none-"), 1024)).toBe("");
	});
});
