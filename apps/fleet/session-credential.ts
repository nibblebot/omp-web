/**
 * Callback credential plumbing for fleet-spawned sessions: minting a fresh
 * credential per generation, revoking it, asking a paired session to shut
 * down, and the `--fleet-stdin` payload the session reads its pair from.
 * Used by the host runtime in workspace-lifecycle.ts; pair-driven tests also
 * enroll through it.
 */

import { randomBytes } from "node:crypto";
import {
	CALLBACK_TRANSPORT_STREAM_ID,
	ENROLLMENT_KEY_BYTES,
	type ShutdownControl,
} from "#lib/wire/callback-protocol";
import type { DaemonTransportRegistry } from "./daemon-transport";
import type { Registry } from "./registry";

/** A session's callback credential for one generation (the raw token is handed to the child once). */
export interface SessionEnrollment {
	generation: number;
	credential: string;
}

/**
 * Enroll a fresh callback credential for the entry's next generation. The
 * previous generation is revoked and cleared FIRST (fencing order, as in
 * workspace-lifecycle): a stale credential can never authenticate against
 * the new launch. The generation is monotonic: one above both the persisted
 * enrollment and the last authorized generation, so it survives a stop
 * (which clears the enrollment). The registry keeps only the digest.
 */
export function enrollSessionCredential(
	transport: DaemonTransportRegistry,
	registry: Registry,
	daemonId: string,
): SessionEnrollment {
	const entry = registry.get(daemonId);
	if (!entry) throw new Error(`unknown daemon ${daemonId}`);
	const previous = entry.workspace?.enrollment;
	if (previous !== undefined) {
		transport.revokeEnrollment(daemonId, previous.generation);
		registry.clearWorkspaceEnrollment(daemonId, previous.generation);
	}
	const generation =
		Math.max(previous?.generation ?? 0, entry.workspace?.authorizedGeneration ?? 0) + 1;
	const credential = randomBytes(ENROLLMENT_KEY_BYTES).toString("hex");
	const digest = transport.enrollWorkspace(daemonId, generation, credential);
	registry.setWorkspaceEnrollment(daemonId, { credentialHash: digest, generation });
	registry.updateWorkspace(daemonId, { authorizedGeneration: generation });
	return { generation, credential };
}

/** Revoke the entry's live callback enrollment and clear its binding (no-op when none). */
export function releaseSessionCredential(
	transport: DaemonTransportRegistry,
	registry: Registry,
	daemonId: string,
): void {
	const enrollment = registry.get(daemonId)?.workspace?.enrollment;
	if (enrollment === undefined) return;
	transport.revokeEnrollment(daemonId, enrollment.generation);
	registry.clearWorkspaceEnrollment(daemonId, enrollment.generation);
}

/**
 * Ask a paired session to shut down gracefully (ShutdownControl on the
 * reserved transport stream). Best effort: resolves false when no pair is
 * live or the send is refused; callers tear the session down regardless.
 */
export async function requestSessionShutdown(
	transport: DaemonTransportRegistry,
	daemonId: string,
	reason: string,
): Promise<boolean> {
	if (!transport.pairStatus(daemonId).paired) return false;
	const control: ShutdownControl = { type: "shutdown", reason };
	try {
		await transport.sendToDaemon(daemonId, {
			streamId: CALLBACK_TRANSPORT_STREAM_ID,
			kind: "control",
			payload: control,
		});
		return true;
	} catch {
		// The pair dropped between the check and the send; the caller's
		// teardown still ends the session.
		return false;
	}
}

/**
 * The `--fleet-stdin` payload for one child: the daemon's only source of its callback pair and
 * listener token, so neither reaches its argv or environment. `allowHttp` is set only for an http
 * callback URL (the daemon honors it for loopback hosts only).
 */
export function fleetStdinPayload(
	callback: { url: string; daemonId: string; enrollment: SessionEnrollment },
	listenerToken: string,
): string {
	const httpCallback = new URL(callback.url).protocol === "http:";
	return JSON.stringify({
		v: 1,
		callback: {
			url: callback.url,
			workspace: callback.daemonId,
			generation: callback.enrollment.generation,
			token: callback.enrollment.credential,
			...(httpCallback ? { allowHttp: true } : {}),
		},
		token: listenerToken,
	});
}
