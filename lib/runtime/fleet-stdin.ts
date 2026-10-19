/**
 * Fleet stdin payload: the callback pair a session daemon reads at boot when
 * started with `--fleet-stdin` (apps/session/config.ts parses it; this module
 * only produces it). The pair travels over stdin, never the daemon's
 * environment: `/proc/<pid>/environ` and every child inherit env.
 *
 * Providers hold the pair as the `OMP_SESSION_CALLBACK_*` env shape in the
 * fleet-written callback-env.json handoff; this is the single conversion to
 * the wire shape:
 *   {"v":1,"callback":{"url","workspace","generation","token","allowHttp"?:true,"proxy"?}}
 */

/** The callback pair as the daemon consumes it. */
export interface FleetCallbackPayload {
	url: string;
	workspace: string;
	generation: number;
	token: string;
	allowHttp?: true;
	proxy?: string;
}

/** The complete `--fleet-stdin` payload (version 1). */
export interface FleetStdinPayload {
	v: 1;
	callback: FleetCallbackPayload;
}

function requiredValue(env: Readonly<Record<string, string | undefined>>, key: string): string {
	const value = env[key];
	if (value === undefined || value === "") {
		throw new Error(`${key} is required to build the fleet stdin payload`);
	}
	return value;
}

/**
 * Serialize the callback pair from `OMP_SESSION_CALLBACK_*`-keyed values.
 * Other keys (for example OMP_SESSION_RESUME) are ignored. Throws on a missing
 * pair member or a non-integer generation; never returns a partial payload.
 */
export function buildFleetStdinPayload(env: Readonly<Record<string, string | undefined>>): string {
	const generationText = requiredValue(env, "OMP_SESSION_CALLBACK_GENERATION");
	const generation = Number(generationText);
	if (!/^\d+$/.test(generationText) || !Number.isSafeInteger(generation)) {
		throw new Error("OMP_SESSION_CALLBACK_GENERATION must be a non-negative integer");
	}
	const callback: FleetCallbackPayload = {
		url: requiredValue(env, "OMP_SESSION_CALLBACK_URL"),
		workspace: requiredValue(env, "OMP_SESSION_CALLBACK_WORKSPACE"),
		generation,
		token: requiredValue(env, "OMP_SESSION_CALLBACK_TOKEN"),
	};
	// The daemon accepts plain http only when the flag is exactly "1".
	if (env.OMP_SESSION_CALLBACK_ALLOW_HTTP === "1") callback.allowHttp = true;
	const proxy = env.OMP_SESSION_CALLBACK_PROXY;
	if (proxy !== undefined && proxy !== "") callback.proxy = proxy;
	const payload: FleetStdinPayload = { v: 1, callback };
	return JSON.stringify(payload);
}
