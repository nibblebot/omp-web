/**
 * Clone runtime process identity (the bwrap provider and the host clone
 * runtime): the pidfile record and the host `/proc` reads behind it. Identity
 * is private to the provider's per-workspace `stateDir`; the shared provider
 * protocol (lib/runtime/provider-protocol.ts) knows nothing of pids. Liveness
 * and `stop` prove the requested generation terminated by this identity,
 * never by a reusable pid alone.
 *
 * Record: `<stateDir>/provider.pid.json` = {pid, procStartTime, generation,
 * workspaceToken, startedAt}. `pid` is the HOST pid of the session command,
 * `procStartTime` is `/proc/<pid>/stat` field 22 recorded at launch, and the
 * launch token is embedded in the session command's argv. Liveness needs
 * the pid alive, not a zombie, with the same procStartTime AND a cmdline that
 * still carries the token, so a reused pid never matches.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Pidfile name inside the provider's per-workspace `stateDir`. */
export const BWRAP_PID_FILE = "provider.pid.json";

/** The provider's launch record for one workspace generation. */
export interface LaunchRecord {
	/** HOST pid of the sandboxed command. */
	pid: number;
	/** `/proc/<pid>/stat` field 22 recorded at launch; with `pid`, survives PID reuse. */
	procStartTime: number;
	/** Authorized generation recorded at launch; stop binds its proof to it. */
	generation: number;
	/** Launch token embedded in the sandboxed command's argv. Provider-private. */
	workspaceToken: string;
	/** Epoch ms the supervisor recorded the launch. */
	startedAt: number;
}

/** Host pids that are direct children of `pid` (read from each tid's children file). */
export function childrenOf(pid: number): number[] {
	try {
		const kids = new Set<number>();
		for (const tid of readdirSync(`/proc/${pid}/task`)) {
			const raw = readFileSync(`/proc/${pid}/task/${tid}/children`, "utf8").trim();
			if (raw.length === 0) continue;
			for (const k of raw.split(" ")) {
				const n = Number(k);
				if (Number.isSafeInteger(n) && n > 0) kids.add(n);
			}
		}
		return [...kids];
	} catch {
		return [];
	}
}

/** The process command line, space-joined ("" when unreadable or gone). */
export function cmdlineOf(pid: number): string {
	try {
		return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
	} catch {
		return "";
	}
}

/**
 * procStartTime (`/proc/<pid>/stat` field 22) + state letter of a pid, or null
 * when gone. `comm` may contain spaces or `)`; the tail after the LAST `) ` is
 * parsed, keeping the field indexes stable.
 */
export function procIdentity(pid: number): { startTime: number; state: string } | null {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const close = stat.lastIndexOf(") ");
		if (close < 0) return null;
		const tail = stat.slice(close + 2).split(" ");
		const startTime = Number(tail[19]);
		const state = tail[0] ?? "";
		if (!Number.isFinite(startTime)) return null;
		return { startTime, state };
	} catch {
		return null;
	}
}

/** Walk descendants of `root` looking for a cmdline containing `token`. */
export function findTokenPid(root: number, token: string): number | null {
	const seen = new Set<number>([root]);
	const queue: number[] = [root];
	while (queue.length > 0) {
		const current = queue.shift()!;
		for (const kid of childrenOf(current)) {
			if (seen.has(kid)) continue;
			seen.add(kid);
			if (cmdlineOf(kid).includes(token)) return kid;
			queue.push(kid);
		}
	}
	return null;
}

/** Read the provider launch record, or null when absent or malformed. */
export function readLaunchRecord(stateDir: string): LaunchRecord | null {
	try {
		const value = JSON.parse(readFileSync(join(stateDir, BWRAP_PID_FILE), "utf8")) as Record<
			string,
			unknown
		>;
		const { pid, procStartTime, generation, workspaceToken, startedAt } = value;
		if (
			typeof pid !== "number" ||
			!Number.isSafeInteger(pid) ||
			pid < 1 ||
			typeof procStartTime !== "number" ||
			!Number.isFinite(procStartTime) ||
			typeof generation !== "number" ||
			!Number.isSafeInteger(generation) ||
			generation < 1 ||
			typeof workspaceToken !== "string" ||
			workspaceToken.length === 0 ||
			typeof startedAt !== "number"
		) {
			return null;
		}
		return { pid, procStartTime, generation, workspaceToken, startedAt };
	} catch {
		return null;
	}
}

/**
 * The workspace identity check: the pid is alive, its procStartTime (stat
 * field 22) matches the record, its state is not a zombie, and its cmdline
 * still contains the workspace token. A missing record or gone process is
 * false ("terminated or unknown, cannot claim live"). Never pid-only.
 */
export function identityLive(record: LaunchRecord | null): boolean {
	if (record === null) return false;
	const identity = procIdentity(record.pid);
	if (identity === null) return false;
	if (identity.state === "Z" || identity.state === "X") return false;
	if (identity.startTime !== record.procStartTime) return false;
	return cmdlineOf(record.pid).includes(record.workspaceToken);
}

/** SIGTERM proof budget before SIGKILL escalation. */
const TERM_PROOF_MS = 10_000;
/** SIGKILL proof budget before declaring the termination unproven. */
const KILL_PROOF_MS = 5_000;
const PROOF_POLL_MS = 50;

/**
 * Terminate the workspace's recorded process and PROVE the generation
 * terminated by identity (re-reading the record each poll), escalating
 * SIGTERM, then SIGKILL. `signal` delivers a signal to the recorded pid (the
 * caller decides whether that reaches the pid or its process group). True
 * when the recorded process is gone or no longer matches the launch identity;
 * false when proof is impossible (the caller reports a conflict).
 */
export async function stopAndProve(
	stateDir: string,
	signal: (pid: number, signal: NodeJS.Signals) => void,
): Promise<boolean> {
	const record = readLaunchRecord(stateDir);
	if (record === null || !identityLive(record)) return true; // already stopped/missing
	const target = record.pid;

	const escalate = async (sig: NodeJS.Signals, budgetMs: number): Promise<boolean> => {
		try {
			signal(target, sig);
		} catch {
			return true;
		}
		const deadline = Date.now() + budgetMs;
		while (Date.now() < deadline) {
			if (!identityLive(readLaunchRecord(stateDir))) return true;
			await Bun.sleep(PROOF_POLL_MS);
		}
		return false;
	};

	if (await escalate("SIGTERM", TERM_PROOF_MS)) return true;
	return await escalate("SIGKILL", KILL_PROOF_MS);
}
