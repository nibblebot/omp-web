/**
 * A WorkspaceLifecycle for tests that drive host (main-checkout and worktree)
 * sessions over a real registry and a real SessionTransportRegistry, without a
 * full fleet server: no log store, no clone provider, a no-op resource deleter.
 */

import { dirname, join } from "node:path";
import type { FleetConfig } from "../config";
import type { SessionTransportRegistry } from "../session-transport";
import { FleetEventLog } from "../events";
import type { Registry } from "../registry";
import { WorkspaceLifecycle, type CloneRuntimePolicy } from "../workspace-lifecycle";

export interface HostLifecycleOptions {
	registry: Registry;
	config: FleetConfig;
	transport: SessionTransportRegistry;
	/** The fleet state file; session logs live beside it under session-logs/. */
	statePath: string;
	callbackUrl: () => string;
	/** Restart budget and backoff overrides (shared restart-policy.ts shape). */
	runtime?: Partial<CloneRuntimePolicy>;
	pairTimeoutMs?: number;
	onEnrolled?: (workspaceId: string) => void;
	onSpawned?: (workspaceId: string) => void;
	eventLog?: FleetEventLog;
}

export function makeHostLifecycle(opts: HostLifecycleOptions): {
	lifecycle: WorkspaceLifecycle;
	eventLog: FleetEventLog;
} {
	const eventLog = opts.eventLog ?? new FleetEventLog();
	const lifecycle = new WorkspaceLifecycle({
		registry: opts.registry,
		config: opts.config,
		statePath: opts.statePath,
		cloneRoot: join(dirname(opts.statePath), "clones"),
		transport: opts.transport,
		logStore: null,
		resourceDeleter: { deleteWorkspaceResources: async () => {} },
		eventLog,
		attachLogTap: () => {},
		callbackUrl: opts.callbackUrl,
		...(opts.runtime !== undefined ? { runtime: opts.runtime } : {}),
		...(opts.pairTimeoutMs !== undefined ? { pairTimeoutMs: opts.pairTimeoutMs } : {}),
		...(opts.onEnrolled !== undefined ? { onEnrolled: opts.onEnrolled } : {}),
		...(opts.onSpawned !== undefined ? { onSpawned: opts.onSpawned } : {}),
	});
	return { lifecycle, eventLog };
}
