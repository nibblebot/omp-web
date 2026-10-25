/**
 * Test-only Bun preload (BUN_OPTIONS=--preload=...) for control-plane.test.ts.
 * Registers a postmortem cleanup whose duration is set by
 * OMP_SESSION_TEST_TEARDOWN, so a shutdown has real async work in flight:
 *   "slow": resolves after 300 ms, so the process outlives a synchronous exit.
 *   "hang": never settles (postmortem's own deadline still bounds it).
 */
import { register } from "@oh-my-pi/pi-utils/postmortem";

const mode = Bun.env.OMP_SESSION_TEST_TEARDOWN;
if (mode === "slow") {
	// A real delay on purpose: the session is a child process, and the race under
	// test is between its real teardown and the real process exit, which fake
	// timers in this process cannot control.
	register("test-slow-teardown", () => Bun.sleep(300));
} else if (mode === "hang") {
	register("test-hang-teardown", () => new Promise<void>(() => {}));
}
