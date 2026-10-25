/**
 * In-pod fleet handoff (Kubernetes): prints the session process's
 * `--fleet-stdin` payload built from the pod's OMP_SESSION_CALLBACK_* env.
 * apps/session/entrypoint.sh captures the output, unsets those variables, and
 * feeds the payload to the session's stdin, so the session process never carries
 * the callback pair in its environment.
 *
 * Prints nothing and exits 0 when the pod carries no callback pair (the session
 * then starts without --fleet-stdin). Exits 1 with a message on a partial or
 * invalid pair.
 */
import { buildFleetStdinPayload } from "#lib/runtime/fleet-stdin";
import { FLEET_CALLBACK_ENV_KEYS } from "#lib/runtime/bwrap-args";

if (!FLEET_CALLBACK_ENV_KEYS.some((key) => process.env[key] !== undefined)) {
	process.exit(0);
}

try {
	process.stdout.write(`${buildFleetStdinPayload(process.env)}\n`);
} catch (cause) {
	process.stderr.write(`fleet-stdin: ${cause instanceof Error ? cause.message : String(cause)}\n`);
	process.exit(1);
}
