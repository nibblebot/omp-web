import { isAbsolute } from "node:path";
import { inspectFileLock } from "#lib/platform/file-lock";
import type { RegistryEntry } from "./registry";

/** Prove local session liveness without dialing a session or changing its lock. */
export function sessionLiveness(entry: RegistryEntry): "alive" | "dead" | "unknown" {
	if (entry.lastSessionFile && isAbsolute(entry.lastSessionFile)) {
		// A freshly spawned, still-unpaired session can retain an older run's
		// lastSessionFile and read as dead until it pairs. The pair listener
		// then restores ready, so this transient self-heals.
		try {
			const lock = inspectFileLock(`${entry.lastSessionFile}.lock`);
			if (lock.state === "held") return "alive";
			if (lock.state === "stale" || lock.state === "free") return "dead";
		} catch {
			// An unexpected probe error cannot prove death; try the recorded pid.
		}
	}
	if (typeof entry.pid === "number" && entry.pid > 0) {
		try {
			process.kill(entry.pid, 0);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ESRCH") return "dead";
		}
	}
	// A live recorded pid may have been reused, so it does not prove life.
	return "unknown";
}
