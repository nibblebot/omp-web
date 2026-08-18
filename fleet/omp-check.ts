/**
 * First-run omp-stack check for the serve offer (fleet/cli.ts serveCmd).
 *
 * Verifies the three things a fresh omp-web needs to be usable: the `omp` CLI
 * installed, at least one provider with usable auth, and a default model
 * selected. Providers and the default model are read through the SDK's own
 * runtime — discoverAuthStorage + ModelRegistry + Settings.loadReadOnly, the
 * same trio the omp-session daemon boots with — so the check reflects exactly
 * what prompts will see, regardless of SDK version or config layout.
 *
 * The SDK is imported LAZILY inside the probe: the fleet is otherwise SDK-free
 * (zero agent state), and this check only runs on the first-run TTY offer.
 * Offline-safe: getApiKeyForProvider resolves storage/config/env keys without
 * forceRefresh.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OmpSetupStatus {
	/** The omp CLI is on PATH or at the standard ~/.bun/bin location. */
	ompInstalled: boolean;
	/** Providers with usable auth (SDK view: storage, config keys, env). */
	providers: string[];
	/** The default-role model selector from settings, or null. */
	defaultModel: string | null;
	/** Probe failure detail (missing SDK, unreadable config), else null. */
	error: string | null;
}

/** omp CLI resolution: PATH, then the standard bun-global bin dir. */
export function resolveOmpBinary(): string | null {
	const onPath = Bun.which("omp");
	if (onPath !== null) return onPath;
	const standard = join(homedir(), ".bun", "bin", "omp");
	return existsSync(standard) ? standard : null;
}

/**
 * Probe the omp stack. `agentDir` overrides the SDK's default (~/.omp/agent)
 * for tests. Never throws — failures come back in `error` with empty
 * providers/model (the offer then advises configuring omp).
 */
export async function checkOmpSetup(agentDir?: string): Promise<OmpSetupStatus> {
	const ompInstalled = resolveOmpBinary() !== null;
	try {
		const [{ getAgentDir }, { discoverAuthStorage, ModelRegistry, Settings }] = await Promise.all([
			import("@oh-my-pi/pi-utils"),
			import("@oh-my-pi/pi-coding-agent"),
		]);
		const dir = agentDir ?? getAgentDir();
		const authStorage = await discoverAuthStorage(dir);
		const registry = new ModelRegistry(authStorage);
		await registry.awaitBackgroundRefresh();
		const settings = await Settings.loadReadOnly({ agentDir: dir });
		// Providers that could actually authenticate a prompt today.
		const models = registry.getAvailable();
		const providers = [...new Set(models.map((m) => m.provider))]
			.filter((provider) => {
				try {
					return registry.getApiKeyForProvider(provider) !== undefined;
				} catch {
					return false;
				}
			})
			.sort();
		// The default-role model selection (the omp TUI /models writes this).
		const roles = settings.get("modelRoles");
		const defaultSelector = (roles as Record<string, unknown> | undefined)?.default;
		const defaultModel =
			typeof defaultSelector === "string" && defaultSelector !== "" ? defaultSelector : null;
		return { ompInstalled, providers, defaultModel, error: null };
	} catch (err) {
		return {
			ompInstalled,
			providers: [],
			defaultModel: null,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * First-run status + advice lines. Printed to STDOUT by the serve offer (the
 * offer is TTY-only, so non-interactive spawners that parse the banner never
 * see these).
 */
export function ompStatusLines(status: OmpSetupStatus): string[] {
	const lines: string[] = [];
	const binary = resolveOmpBinary();
	lines.push(
		status.ompInstalled
			? `omp: installed (${binary ?? "?"})`
			: "omp: NOT installed — run: bun install -g @oh-my-pi/pi-coding-agent",
	);
	lines.push(
		status.providers.length > 0
			? `providers: ${status.providers.join(", ")}`
			: "providers: none configured",
	);
	lines.push(
		status.defaultModel !== null ? `default model: ${status.defaultModel}` : "default model: none",
	);
	if (!status.ompInstalled || status.providers.length === 0 || status.defaultModel === null) {
		lines.push(
			"first configure omp: run `omp` and set up a provider + default model in its /settings",
			"(or `omp login` for an OAuth provider). omp-web serves anyway, but prompts fail",
			"until a model resolves.",
		);
	}
	if (status.error !== null) lines.push(`omp probe error: ${status.error}`);
	return lines;
}
