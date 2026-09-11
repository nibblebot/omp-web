/**
 * Clone-workspace HTTP control surface (clone-plan P1/P6/P7/P8; frozen
 * contract docs/clone-contracts.md "Browser and CLI workspace creation").
 *
 * A thin route layer over the single fleet-internal lifecycle service
 * (fleet/workspace-lifecycle.ts): the browser create route and the secret-free
 * profile catalog. fleet/server.ts mounts it for POST /ctl/clones and GET
 * /ctl/profiles; the remaining clone lifecycle routes (/ctl/start|wake,
 * /ctl/stop, /ctl/remove, DELETE /ctl/worktrees/:id) call the same lifecycle
 * owner directly from server.ts — one owner, no duplicate HTTP paths, no HTTP
 * self-fetch.
 *
 * Wire contracts:
 *   POST /ctl/clones {projectId, name, profileId, source?, revision?,
 *                     branch?, start?} → 201 {entry: DaemonEntry}
 *   GET  /ctl/profiles → {profiles: PublicProviderProfile[]} (secret-free)
 *
 * Typed failures reuse the frozen ledger vocabulary with caller-safe
 * messages; the HTTP layer maps them onto status codes.
 */

import type { PublicProviderProfile } from "../shared/protocol";
import type { ProviderProfile } from "./provider-profile";
import { toPublicProfile } from "./provider-profile";
import { toRosterEntry } from "./roster-projection";
import {
	CloneLifecycleError,
	type WorkspaceLifecycle,
	type CloneCreateInput,
} from "./workspace-lifecycle";
import type { FleetEventLog } from "./events";

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** Map a lifecycle failure onto the HTTP status the CLI/UI expects. */
export function lifecycleStatus(code: CloneLifecycleError["code"]): number {
	switch (code) {
		case "invalid_request":
		case "invalid_identity":
			return 400;
		case "unauthorized":
			return 401;
		case "forbidden":
			return 403;
		case "conflict":
		case "generation_obsolete":
		case "writer_active":
		case "archive_pending":
		case "archive_conflict":
			return 409;
		case "unavailable":
		case "retryable":
			return 503;
		case "provider_failed":
			return 500;
		default:
			return 500;
	}
}

/**
 * The clones control app: the create route plus the secret-free profile
 * catalog. Every mutation goes through {@link WorkspaceLifecycle} — the
 * authoritative create/ensure/stop/delete owner — and the server's own
 * /ctl/start|stop|remove and DELETE /ctl/worktrees routes call that owner
 * directly, so this app carries no duplicate lifecycle wrappers.
 */
export class CloneControlApi {
	readonly #lifecycle: WorkspaceLifecycle;
	readonly #eventLog: FleetEventLog;
	/** Boot-static profile catalog (secret-free projection). */
	readonly #publicProfiles: Record<string, PublicProviderProfile>;

	constructor(deps: {
		lifecycle: WorkspaceLifecycle;
		config: { providerProfiles?: Record<string, ProviderProfile> };
		eventLog: FleetEventLog;
	}) {
		this.#lifecycle = deps.lifecycle;
		this.#eventLog = deps.eventLog;
		const profiles: Record<string, PublicProviderProfile> = {};
		if (deps.config.providerProfiles !== undefined) {
			for (const profile of Object.values(deps.config.providerProfiles)) {
				profiles[profile.id] = toPublicProfile(profile);
			}
		}
		this.#publicProfiles = profiles;
	}

	/** GET /ctl/profiles → { profiles: PublicProviderProfile[] } (secret-free). */
	profiles(): { profiles: PublicProviderProfile[] } {
		return { profiles: Object.values(this.#publicProfiles) };
	}

	/** POST /ctl/clones (frozen contract). Returns 201 {entry: DaemonEntry}.
	 *  The response is the PUBLIC roster projection: the fleet-private
	 *  workspace record (provider handle, binding, enrollment, deletion
	 *  state, clone source) never crosses the route boundary. */
	async createClone(body: CloneCreateInput): Promise<Response> {
		const entry = await this.#lifecycle.createClone(body);
		this.#eventLog.add("info", "server", `clone created ${entry.daemonId}`, entry.daemonId);
		return json({ entry: toRosterEntry(entry) }, 201);
	}
}
