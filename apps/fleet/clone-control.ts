/**
 * Clone-workspace HTTP control helpers.
 *
 * The provider profile catalog route and the lifecycle-failure status map.
 * Clone and session mutations live nowhere in this module: every create,
 * start, stop and delete goes through the lifecycle owner
 * (fleet/workspace-lifecycle.ts, via FleetOperations and the server's
 * routes), so a route can never bypass the delete gate or hold a second
 * implementation of a verb.
 *
 *   GET  /ctl/profiles → {profiles: PublicProviderProfile[]} (secret-free)
 *
 * Typed lifecycle failures reuse the frozen ledger vocabulary with
 * caller-safe messages; `lifecycleStatus` maps them onto HTTP statuses.
 */

import { CALLBACK_ERROR_HTTP_STATUS } from "#lib/wire/callback-protocol";
import type { PublicProviderProfile } from "#lib/wire/protocol";
import type { ProviderProfile } from "#lib/runtime/provider-protocol";
import { toPublicProfile } from "./provider-profile";
import type { CloneLifecycleError } from "./workspace-lifecycle";

/** Map a lifecycle failure onto the HTTP status the CLI/UI expects: the callback error table. */
export function lifecycleStatus(code: CloneLifecycleError["code"]): number {
	return CALLBACK_ERROR_HTTP_STATUS[code];
}

/** The boot-static provider profile catalog (secret-free projection). */
export class CloneControlApi {
	readonly #publicProfiles: Record<string, PublicProviderProfile>;

	constructor(deps: { config: { providerProfiles?: Record<string, ProviderProfile> } }) {
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
}
