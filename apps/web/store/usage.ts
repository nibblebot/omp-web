import type { UsageReport } from "@oh-my-pi/pi-ai";
import { setState, state } from "../state";
import { authedFetch } from "./auth";
import { ctlError } from "./settings";

/**
 * Usage domain (Phase 3 store facade split): provider usage reports from the
 * fleet control plane (GET /ctl/usage), mirrored into state.usage* with
 * one-shot, single-flight refresh semantics. Usage is provider-account data,
 * not session data, so it needs neither the /events stream nor an attached
 * session. The SDK caches provider /usage for ~5min upstream (with jitter),
 * so callers must never poll; they re-run refreshUsageReports() on mount or
 * on user action and read the mirror.
 */

/** localStorage key for the Phase 12 roster-sidebar usage widget toggle. */
const USAGE_SIDEBAR_KEY = "omp.sidebarUsage";

/**
 * Fetch usage reports once (no-op while a fetch is already in flight).
 * Success mirrors the body into state.usageReports (a null body becomes [])
 * and clears state.usageError; failure lands in
 * state.usageError (the {error} message of a non-ok response, else the thrown
 * message). state.usageLoading tracks the in-flight window for both the modal
 * and the sidebar widget.
 */
export function refreshUsageReports(): void {
	if (state.usageLoading) return;
	setState("usageLoading", true);
	void (async () => {
		try {
			const res = await (state.authStatus !== "disabled" ? authedFetch : fetch)("/ctl/usage");
			if (!res.ok) throw new Error(await ctlError(res));
			setState("usageReports", ((await res.json()) as UsageReport[] | null) ?? []);
			setState("usageError", null);
		} catch (err) {
			setState("usageError", err instanceof Error ? err.message : String(err));
		} finally {
			setState("usageLoading", false);
		}
	})();
}

/** Persist + apply the roster-sidebar usage widget toggle. */
export function setSidebarUsage(enabled: boolean): void {
	if (typeof localStorage !== "undefined") localStorage.setItem(USAGE_SIDEBAR_KEY, String(enabled));
	setState("sidebarUsage", enabled);
}
