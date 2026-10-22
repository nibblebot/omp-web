/**
 * Unattached-fleet usage service (the fleet control plane's /ctl/usage).
 *
 * Provider usage reports are provider-account data read from the auth storage
 * in the agent dir, not session state. The session RPC fetchUsageReports needs
 * an attached AgentSession, so it fails before the browser socket connects and before any
 * session is attached. This service reads the same SDK source without a
 * session: the base URL resolution matches AgentSession.fetchUsageReports, and
 * no usage support (authStorage.usage.reports absent) yields []. The SDK caches
 * provider usage upstream (about 5 minutes), so each GET may call it.
 */

import type { UsageReport } from "@oh-my-pi/pi-ai";
import { ensureModelRegistry, ensureSettings } from "./sdk-singletons";

export interface FleetUsage {
	getReports(): Promise<UsageReport[]>;
}

export interface FleetUsageOptions {
	/**
	 * Provider usage source, injectable for tests (tests must not open the real
	 * auth DB or reach the network). Defaults to the SDK auth storage. Resolving
	 * null means no usage support; a rejection is reported as a failure.
	 */
	source?: () => Promise<UsageReport[] | null>;
}

export function createFleetUsage(options: FleetUsageOptions = {}): FleetUsage {
	const source = options.source ?? fetchAccountUsage;
	return {
		getReports: async () => (await source()) ?? [],
	};
}

async function fetchAccountUsage(): Promise<UsageReport[] | null> {
	const [{ authStorage, registry }, settings, { cfgProvidersAntigravityEndpoint }] =
		await Promise.all([
			ensureModelRegistry(),
			ensureSettings(),
			import("@oh-my-pi/pi-coding-agent/session/settings"),
		]);
	if (!authStorage.usage.reports) return null;
	return authStorage.usage.reports({
		// Same resolution as AgentSession.fetchUsageReports: the antigravity
		// endpoint setting first, then the registry's configured base URL.
		baseUrlResolver: (provider) => {
			if (provider === "google-antigravity") {
				const endpoint = cfgProvidersAntigravityEndpoint.get(settings);
				if (endpoint === "sandbox") return "https://daily-cloudcode-pa.sandbox.googleapis.com";
				if (endpoint === "production") return "https://daily-cloudcode-pa.googleapis.com";
			}
			return registry.getProviderBaseUrl?.(provider);
		},
	});
}
