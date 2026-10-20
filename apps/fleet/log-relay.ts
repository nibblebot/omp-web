/**
 * Capped log relay for a clone runtime that outlives the fleet (the host clone
 * kind): copies its stdin, the runtime's combined stdout and stderr, into the
 * workspace's daemon log through the shared SessionLog writer, which rotates
 * at the cap mid-run exactly like the bwrap supervisor's log (session-log.ts).
 *
 * It is its own detached process because a pipe whose reader is the fleet
 * would break when the fleet exits, and the runtime would die of SIGPIPE. It
 * ignores the stop signals the runtime's process group receives, so the
 * runtime's last output still lands, and ends at EOF when the runtime exits.
 *
 * Run as `omp-web log-relay <logPath>` (apps/cli/omp-web.ts in the source
 * tree, cli.js in the installed bundle); see logRelayLaunch.
 */

import { SessionLog, pumpToSessionLog } from "./session-log";

export async function runLogRelay(logPath: string): Promise<void> {
	if (logPath === "") throw new Error("usage: omp-web log-relay <logPath>");
	for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => {});
	const log = new SessionLog(logPath);
	await pumpToSessionLog(Bun.stdin.stream(), log);
	log.close();
}
