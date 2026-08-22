import type { UsageReport } from "@oh-my-pi/pi-ai";
import { setState, state } from "../state";
import { call } from "./transport";

/**
 * Usage domain (Phase 3 store facade split): the READ_ONLY fetchUsageReports
 * relay row (server/methods.ts) mirrored into state.usage* with one-shot,
 * single-flight refresh semantics — the SDK caches provider /usage for ~5min
 * upstream (with jitter), so callers must never poll; they re-run
 * refreshUsageReports() on mount or on user action and read the mirror.
 */

/** localStorage key for the Phase 12 roster-sidebar usage widget toggle. */
const USAGE_SIDEBAR_KEY = "omp.sidebarUsage";

/**
 * Fetch usage reports once (no-op while a fetch is already in flight).
 * Success mirrors the result into state.usageReports (null/undefined →
 * []); failure lands in state.usageError. state.usageLoading tracks the
 * in-flight window for both the modal and the sidebar widget.
 */
export function refreshUsageReports(): void {
	if (state.usageLoading) return;
	setState("usageLoading", true);
	call("fetchUsageReports")
		.then((result) => {
			setState("usageReports", (result as UsageReport[] | null) ?? []);
			setState("usageError", null);
		})
		.catch((err) => setState("usageError", String(err)))
		.finally(() => setState("usageLoading", false));
}

/** Persist + apply the roster-sidebar usage widget toggle. */
export function setSidebarUsage(enabled: boolean): void {
	if (typeof localStorage !== "undefined") localStorage.setItem(USAGE_SIDEBAR_KEY, String(enabled));
	setState("sidebarUsage", enabled);
}
