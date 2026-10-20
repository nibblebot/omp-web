/**
 * The runtime-provider contract the workspace lifecycle drives for every
 * workspace kind: the four provider ops (ensure-running, inspect, stop,
 * delete), answered with the provider protocol's typed envelope (an ok
 * observation or a typed error, never a throw for an operational failure).
 *
 * Two implementations: executable providers (bwrap, kubernetes) run as a
 * one-shot process per op over `runProviderOp`; the host provider
 * (host-provider.ts) is in-process, for sessions that run as children of the
 * fleet on the fleet host. The request shape is each implementation's own;
 * the lifecycle builds the right one for the workspace's kind.
 */

import { runProviderOp } from "#lib/runtime/provider-exec";
import type {
	ProviderErrorResponse,
	ProviderOkResponse,
	ProviderOp,
	ProviderRequest,
} from "#lib/runtime/provider-protocol";

/** A provider request for one of the lifecycle ops (preflight is the CLI's, not the lifecycle's). */
export type ExecutableRequest = ProviderRequest & { op: Exclude<ProviderOp, "preflight"> };

export interface RuntimeProvider<Req, Ok extends ProviderOkResponse = ProviderOkResponse> {
	run(request: Req): Promise<Ok | ProviderErrorResponse>;
}

/** The out-of-process provider behind a profile's `executable`. */
export function executableRuntimeProvider(executable: string): RuntimeProvider<ExecutableRequest> {
	return { run: (request) => runProviderOp(executable, request) };
}
