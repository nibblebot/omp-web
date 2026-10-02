/**
 * Clone-workspace HTTP control surface (clone-plan P1/P6/P7/P8; frozen
 * contract docs/clone-contracts.md "Browser and CLI workspace creation").
 *
 * A thin route layer over the single fleet-internal lifecycle service
 * (fleet/workspace-lifecycle.ts): the CLI and the browser edge share the
 * same create/ensure/stop/delete owner, and the clone delete gate can never
 * be bypassed by a route. Mounted by fleet/server.ts under /ctl/clones,
 * /ctl/profiles, /ctl/start|wake, /ctl/stop (clone dispatch), and DELETE
 * /ctl/worktrees/:id (kind dispatch). No HTTP self-fetch and no second
 * lifecycle implementation.
 *
 * Wire contracts:
 *   POST /ctl/clones {projectId, name, profileId, source?, revision?,
 *                     branch?, start?} → 201 {entry: DaemonEntry}
 *   GET  /ctl/profiles → {profiles: PublicProviderProfile[]} (secret-free)
 *   POST /ctl/start|wake {daemonId} → ensure-running (clone-only)
 *   POST /ctl/stop {selector} → clone entries take the proof-bearing stop
 *   DELETE /ctl/worktrees/:daemonId → kind-dispatch to the verified gate
 *   POST /ctl/remove {selector} → clone entries hit the SAME verified gate
 *
 * Typed failures reuse the frozen ledger vocabulary with caller-safe
 * messages; the HTTP layer maps them onto status codes.
 */

import type { Registry } from "./registry";
import type { PublicProviderProfile } from "#lib/wire/protocol";
import type { ProviderProfile } from "./provider-profile";
import { toPublicProfile } from "./provider-profile";
import {
	CloneLifecycleError,
	type WorkspaceLifecycle,
	type CloneCreateInput,
} from "./workspace-lifecycle";
import type { FleetEventLog } from "./events";

/** curl/HTTP error with a message safe to return to the caller. */
export class CloneHttpError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

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
 * The clones control app: mount responses for the fleet server. Every
 * mutation goes through {@link WorkspaceLifecycle}, the authoritative
 * create/ensure/stop/delete owner.
 */
export class CloneControlApi {
	readonly #lifecycle: WorkspaceLifecycle;
	readonly #registry: Registry;
	readonly #eventLog: FleetEventLog;
	/** Boot-static profile catalog (secret-free projection). */
	readonly #publicProfiles: Record<string, PublicProviderProfile>;

	constructor(deps: {
		lifecycle: WorkspaceLifecycle;
		registry: Registry;
		config: { providerProfiles?: Record<string, ProviderProfile> };
		eventLog: FleetEventLog;
	}) {
		this.#lifecycle = deps.lifecycle;
		this.#registry = deps.registry;
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

	/** POST /ctl/clones (frozen contract). Returns 201 {entry: DaemonEntry}. */
	async createClone(body: CloneCreateInput): Promise<Response> {
		const entry = await this.#lifecycle.createClone(body);
		this.#eventLog.add("info", "server", `clone created ${entry.daemonId}`, entry.daemonId);
		return json({ entry }, 201);
	}

	/** POST /ctl/start|wake {daemonId}: clone-only ensure-running. */
	async start(body: { daemonId?: unknown }): Promise<Response> {
		if (typeof body.daemonId !== "string" || body.daemonId === "") {
			throw new CloneHttpError(400, "invalid_request", "missing or invalid field: daemonId");
		}
		// ensureCloneRunning is a service-level ensure; resolve synchronously.
		await this.#lifecycle.ensureCloneRunning(body.daemonId);
		const entry = this.#registry.get(body.daemonId);
		return json({
			daemonId: body.daemonId,
			observed: "running",
			...(entry?.workspace?.providerHandle !== undefined
				? { handle: entry.workspace.providerHandle }
				: {}),
		});
	}

	/**
	 * POST /ctl/stop {selector}: clone entries take the proof-bearing
	 * provider stop (desiredState stopped); direct/worktree entries keep
	 * their existing supervisor/connector paths (dispatched by kind by the
	 * server, which owns registry + connector + supervisor for those).
	 */
	async stop(selector: string): Promise<{ stopped: string[] }> {
		const matches = this.#registry
			.list()
			.filter((entry) => entry.daemonId === selector || entry.name === selector);
		if (matches.length === 0) {
			throw new CloneHttpError(404, "not_found", `no daemon matches selector: ${selector}`);
		}
		const stopped: string[] = [];
		for (const entry of matches) {
			if (entry.workspace?.kind === "clone") {
				await this.#lifecycle.stopClone(entry.daemonId);
			}
			stopped.push(entry.daemonId);
		}
		return { stopped };
	}

	/**
	 * POST /ctl/remove {selector}: clone entries route through the SAME
	 * verified delete gate as DELETE /ctl/worktrees/:id; removal can never
	 * bypass it. Direct/worktree entries are removed by the server's legacy
	 * path (kind-dispatched at the caller).
	 */
	async remove(selector: string): Promise<{ removed: string[]; verified?: string[] }> {
		const matches = this.#registry
			.list()
			.filter((entry) => entry.daemonId === selector || entry.name === selector);
		if (matches.length === 0) {
			throw new CloneHttpError(404, "not_found", `no daemon matches selector: ${selector}`);
		}
		const removed: string[] = [];
		let verified: string[] = [];
		const clonesVerified: string[] = [];
		for (const entry of matches) {
			if (entry.workspace?.kind === "clone") {
				const result = await this.#lifecycle.deleteClone(entry.daemonId);
				clonesVerified.push(...result.verified);
			}
			removed.push(entry.daemonId);
		}
		if (clonesVerified.length > 0) verified = clonesVerified;
		return { removed, ...(verified.length > 0 ? { verified } : {}) };
	}

	/** DELETE /ctl/worktrees/:daemonId → kind-dispatched verified gate. */
	async deleteWorktree(
		daemonId: string,
	): Promise<{ removed: string; verified: string[] } | { removed: string; legacy: string }> {
		const entry = this.#registry.get(daemonId);
		if (!entry) {
			throw new CloneHttpError(404, "not_found", `unknown daemon: ${daemonId}`);
		}
		if (entry.workspace?.kind === "clone") {
			return await this.#lifecycle.deleteClone(daemonId);
		}
		return { removed: daemonId, legacy: "worktree" as const };
	}

	/** Error → Response adapter (message-safe). */
	toResponse(err: unknown): Response {
		if (err instanceof CloneHttpError) return json({ error: err.message }, err.status);
		if (err instanceof CloneLifecycleError) {
			const status = lifecycleStatus(err.code);
			return json({ error: { code: err.code, message: err.message } }, status);
		}
		const message = err instanceof Error ? err.message : String(err);
		return json({ error: message }, 500);
	}
}
