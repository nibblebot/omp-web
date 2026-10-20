/**
 * A WorkspaceLifecycle for tests that drive host (main-checkout and worktree)
 * sessions over a real registry and a real DaemonTransportRegistry, without a
 * full fleet server: no log store, no clone provider, a no-op resource deleter.
 */

import { dirname, join } from "node:path";
import type { FleetConfig } from "../config";
import type { DaemonTransportRegistry } from "../daemon-transport";
import { FleetEventLog } from "../events";
import type { Registry } from "../registry";
import { WorkspaceLifecycle, type CloneRuntimePolicy } from "../workspace-lifecycle";

export interface HostLifecycleOptions {
	registry: Registry;
	config: FleetConfig;
	transport: DaemonTransportRegistry;
	/** The fleet state file; session logs live beside it under session-logs/. */
	statePath: string;
	callbackUrl: () => string;
	/** Restart budget and backoff overrides (shared restart-policy.ts shape). */
	runtime?: Partial<CloneRuntimePolicy>;
	pairTimeoutMs?: number;
	onEnrolled?: (daemonId: string) => void;
	onSpawned?: (daemonId: string) => void;
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
