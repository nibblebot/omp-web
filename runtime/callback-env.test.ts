/**
 * Callback-env handoff contract (`<stateDir>/callback-env.json`, P3.5 stage 2):
 * the fleet writes the sandbox env handoff before invoking a provider and the
 * provider reads it back. These cases pin the observable contract on both
 * sides: the record round-trips, the file is published as a private 0600
 * regular file, symlinks and malformed/oversized/disallowed records are
 * refused with the frozen ledger codes, identity mismatches are `conflict`,
 * and the shared env allowlist is exact (`OMP_SESSION_CALLBACK_*` plus the two
 * wake-resume keys, and nothing else).
 *
 * Every filesystem fixture is a tracked `tempDir()` scratch dir.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../shared/testkit";
import {
	CALLBACK_ENV_FILE,
	CALLBACK_ENV_VERSION,
	isAllowedCallbackEnvKey,
	readCallbackEnvFile,
	writeCallbackEnvFile,
	type CallbackEnvRecord,
} from "./callback-env";

afterAll(cleanupTempDirs);

/** The callback keys the sandbox handoff carries (subset of ENV_ALLOW_KEYS). */
const CALLBACK_KEYS = [
	"OMP_SESSION_CALLBACK_URL",
	"OMP_SESSION_CALLBACK_WORKSPACE",
	"OMP_SESSION_CALLBACK_GENERATION",
	"OMP_SESSION_CALLBACK_TOKEN",
	"OMP_SESSION_CALLBACK_PROXY",
	"OMP_SESSION_CALLBACK_ALLOW_HTTP",
] as const;

function record(overrides: Partial<CallbackEnvRecord> = {}): CallbackEnvRecord {
	return {
		version: CALLBACK_ENV_VERSION,
		workspaceId: "d1",
		generation: 3,
		env: {
			OMP_SESSION_CALLBACK_URL: "https://fleet.example.com",
			OMP_SESSION_CALLBACK_WORKSPACE: "d1",
			OMP_SESSION_CALLBACK_GENERATION: "3",
			OMP_SESSION_CALLBACK_TOKEN: "credential-bytes",
		},
		...overrides,
	};
}

/** The typed ledger code carried by a thrown error, or "" when none is present. */
function errorCode(err: unknown): string {
	if (typeof err === "object" && err !== null && "code" in err && typeof err.code === "string") {
		return err.code;
	}
	return "";
}

/** The typed ledger code thrown by a synchronous call (never returns). */
function syncCode(fn: () => unknown): string {
	try {
		fn();
	} catch (err) {
		return errorCode(err);
	}
	throw new Error("expected the call to throw");
}

const targetOf = (stateDir: string): string => join(stateDir, CALLBACK_ENV_FILE);

describe("readCallbackEnvFile when no handoff exists", () => {
	test("an absent file is null, and so is a state dir that does not exist yet", () => {
		expect(readCallbackEnvFile(tempDir("omp-callback-env-"))).toBeNull();
		expect(readCallbackEnvFile(join(tempDir("omp-callback-env-"), "not-created"))).toBeNull();
	});
});

describe("write/read round-trip", () => {
	test("the record round-trips verbatim and lands at mode 0600", () => {
		const stateDir = tempDir("omp-callback-env-");
		const written = record({
			env: {
				...record().env,
				OMP_SESSION_RESUME: "/workspace/.home/agent/sessions/s1/main.jsonl",
				OMP_SESSION_RESUME_REQUIRED: "1",
			},
		});
		writeCallbackEnvFile(stateDir, written);

		expect(readCallbackEnvFile(stateDir)).toEqual(written);
		const stat = statSync(targetOf(stateDir));
		expect(stat.isFile()).toBe(true);
		expect(stat.mode & 0o777).toBe(0o600);
		// The published file is the encoded record, not some sibling temp file.
		expect(JSON.parse(readFileSync(targetOf(stateDir), "utf8"))).toEqual(written);
	});

	test("a rewrite replaces the previous handoff atomically and leaves no temp files", () => {
		const stateDir = tempDir("omp-callback-env-");
		writeCallbackEnvFile(stateDir, record());
		writeCallbackEnvFile(stateDir, record({ generation: 4 }));
		expect(readCallbackEnvFile(stateDir)!.generation).toBe(4);
		const siblings = readdirSync(stateDir);
		expect(siblings).toEqual([CALLBACK_ENV_FILE]);
	});
});

describe("symlink rejection", () => {
	test("a symlinked target file is rejected on write and on read", () => {
		const stateDir = tempDir("omp-callback-env-");
		const outside = join(tempDir("omp-callback-env-"), "outside.json");
		writeFileSync(outside, JSON.stringify(record()));
		symlinkSync(outside, targetOf(stateDir));

		expect(syncCode(() => writeCallbackEnvFile(stateDir, record()))).toBe("unavailable");
		expect(syncCode(() => readCallbackEnvFile(stateDir))).toBe("unavailable");
		// The link was never followed and the outside file was never replaced.
		expect(readFileSync(outside, "utf8")).toBe(JSON.stringify(record()));
	});

	test("a state dir reached through a symlink is rejected on write and on read", () => {
		const real = tempDir("omp-callback-env-");
		writeCallbackEnvFile(real, record());
		const link = join(tempDir("omp-callback-env-"), "state-link");
		symlinkSync(real, link);

		expect(syncCode(() => writeCallbackEnvFile(link, record()))).toBe("unavailable");
		expect(syncCode(() => readCallbackEnvFile(link))).toBe("unavailable");
	});
});

describe("record validation", () => {
	test("an oversized env value is invalid_request on write and unavailable on read", () => {
		const stateDir = tempDir("omp-callback-env-");
		const oversized = "x".repeat(4097);
		expect(
			syncCode(() =>
				writeCallbackEnvFile(stateDir, record({ env: { OMP_SESSION_CALLBACK_TOKEN: oversized } })),
			),
		).toBe("invalid_request");
		// Hand-written on disk (the writer refuses it): the reader refuses too.
		writeFileSync(
			targetOf(stateDir),
			JSON.stringify({
				version: CALLBACK_ENV_VERSION,
				workspaceId: "d1",
				generation: 1,
				env: { OMP_SESSION_CALLBACK_TOKEN: oversized },
			}),
		);
		expect(syncCode(() => readCallbackEnvFile(stateDir))).toBe("unavailable");
	});

	test("a disallowed env key is invalid_request on write and unavailable on read", () => {
		const stateDir = tempDir("omp-callback-env-");
		// PATH is allowlisted for the sandbox but is not a callback-env key.
		expect(
			syncCode(() => writeCallbackEnvFile(stateDir, record({ env: { PATH: "/usr/bin" } }))),
		).toBe("invalid_request");
		writeFileSync(
			targetOf(stateDir),
			JSON.stringify({
				version: CALLBACK_ENV_VERSION,
				workspaceId: "d1",
				generation: 1,
				env: { PATH: "/usr/bin" },
			}),
		);
		expect(syncCode(() => readCallbackEnvFile(stateDir))).toBe("unavailable");
	});

	test("a corrupt or non-object body is unavailable and never partially interpreted", () => {
		const corrupt = tempDir("omp-callback-env-");
		writeFileSync(targetOf(corrupt), "{ not json");
		expect(syncCode(() => readCallbackEnvFile(corrupt))).toBe("unavailable");

		const nonObject = tempDir("omp-callback-env-");
		writeFileSync(targetOf(nonObject), JSON.stringify(["not", "a", "record"]));
		expect(syncCode(() => readCallbackEnvFile(nonObject))).toBe("unavailable");

		const wrongVersion = tempDir("omp-callback-env-");
		writeFileSync(
			targetOf(wrongVersion),
			JSON.stringify({ ...record(), version: CALLBACK_ENV_VERSION + 1 }),
		);
		expect(syncCode(() => readCallbackEnvFile(wrongVersion))).toBe("unavailable");
	});
});

describe("identity and required-key gating", () => {
	test("a workspaceId mismatch is conflict; a matching read succeeds", () => {
		const stateDir = tempDir("omp-callback-env-");
		writeCallbackEnvFile(stateDir, record({ workspaceId: "d1" }));
		expect(syncCode(() => readCallbackEnvFile(stateDir, { workspaceId: "other" }))).toBe(
			"conflict",
		);
		expect(readCallbackEnvFile(stateDir, { workspaceId: "d1" })!.workspaceId).toBe("d1");
	});

	test("a generation mismatch is conflict (a stale enrollment never starts a new generation)", () => {
		const stateDir = tempDir("omp-callback-env-");
		writeCallbackEnvFile(stateDir, record({ generation: 2 }));
		expect(syncCode(() => readCallbackEnvFile(stateDir, { generation: 3 }))).toBe("conflict");
		expect(readCallbackEnvFile(stateDir, { generation: 2 })!.generation).toBe(2);
	});

	test("opts.required names a missing key: unavailable; a present one passes", () => {
		const stateDir = tempDir("omp-callback-env-");
		writeCallbackEnvFile(stateDir, record());
		expect(
			syncCode(() => readCallbackEnvFile(stateDir, { required: ["OMP_SESSION_RESUME"] })),
		).toBe("unavailable");
		expect(
			readCallbackEnvFile(stateDir, { required: ["OMP_SESSION_CALLBACK_TOKEN"] })!.env
				.OMP_SESSION_CALLBACK_TOKEN,
		).toBe("credential-bytes");
	});

	test("opts.required names a key stored empty: unavailable", () => {
		const stateDir = tempDir("omp-callback-env-");
		writeFileSync(
			targetOf(stateDir),
			JSON.stringify({
				version: CALLBACK_ENV_VERSION,
				workspaceId: "d1",
				generation: 1,
				env: { OMP_SESSION_CALLBACK_TOKEN: "" },
			}),
		);
		expect(
			syncCode(() => readCallbackEnvFile(stateDir, { required: ["OMP_SESSION_CALLBACK_TOKEN"] })),
		).toBe("unavailable");
	});
});

describe("isAllowedCallbackEnvKey", () => {
	test("accepts every callback key and the two wake-resume hints", () => {
		for (const key of CALLBACK_KEYS) expect(isAllowedCallbackEnvKey(key)).toBe(true);
		expect(isAllowedCallbackEnvKey("OMP_SESSION_RESUME")).toBe(true);
		expect(isAllowedCallbackEnvKey("OMP_SESSION_RESUME_REQUIRED")).toBe(true);
	});

	test("rejects arbitrary, prefix-only, and non-callback sandbox names", () => {
		expect(isAllowedCallbackEnvKey("PATH")).toBe(false);
		expect(isAllowedCallbackEnvKey("OMP_SESSION_CALLBACK_NOPE")).toBe(false);
		expect(isAllowedCallbackEnvKey("OMP_SESSION_CALLBACK_")).toBe(false);
		expect(isAllowedCallbackEnvKey("OMP_WORKSPACE_ID")).toBe(false);
	});
});
