/**
 * Profile `secretRefs` resolution for the providers whose capability is
 * `secretResolution: "fleet-env"` (bwrap, host): the provider resolves each
 * reference to a concrete runtime env value from its own environment, which
 * for both is the fleet's. Kubernetes resolves references API-side instead.
 *
 * Pure apart from reading the environment passed in: nothing here touches
 * disk, argv, or the request JSON.
 */

import { ProviderProtocolError, type ProviderRequest } from "./provider-protocol";

/** Secret-ref scheme prefix: the value is an environment variable name. */
const SECRET_ENV_SCHEME = "env:";
/** Secret-values bound (values ride the runtime's process env). */
const SECRET_MAX_CHARS = 4096;

/**
 * Resolve profile `secretRefs` to concrete runtime env values (P5.5).
 * Scheme `env:NAME` reads the named variable from `env`: selected model
 * credentials are supplied to the fleet, never mounted from the operator
 * agent dir. Unknown schemes are configuration errors (`invalid_request`); a
 * missing variable is `unavailable` with actionable remediation (the operator
 * must provision it before launch). The result maps each secret name to its
 * value.
 */
export function resolveProfileSecrets(
	request: ProviderRequest,
	env: Record<string, string | undefined> = process.env,
): Record<string, string> {
	const refs = request.profile.secretRefs;
	const resolved: Record<string, string> = {};
	if (refs === undefined) return resolved;
	for (const [name, ref] of Object.entries(refs)) {
		if (!ref.startsWith(SECRET_ENV_SCHEME)) {
			throw new ProviderProtocolError(
				"invalid_request",
				`secretRefs.${name}: unsupported secret reference scheme "${ref}" (expected ${SECRET_ENV_SCHEME}NAME)`,
				{},
			);
		}
		const varName = ref.slice(SECRET_ENV_SCHEME.length);
		if (varName.length === 0) {
			throw new ProviderProtocolError(
				"invalid_request",
				`secretRefs.${name}: empty environment variable name in reference "${ref}"`,
				{},
			);
		}
		if (!/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(varName)) {
			throw new ProviderProtocolError(
				"invalid_request",
				`secretRefs.${name}: "${varName}" is not a valid POSIX environment variable name`,
				{},
			);
		}
		const value = env[varName];
		if (value === undefined) {
			throw new ProviderProtocolError(
				"unavailable",
				`secretRefs.${name} references environment variable ${varName}, which is not set on the fleet host; provide it to the provider process (e.g. systemd unit EnvironmentFile) or fix the reference`,
				{},
			);
		}
		if (value.length === 0 || value.length > SECRET_MAX_CHARS) {
			throw new ProviderProtocolError(
				"invalid_request",
				`secretRefs.${name}: ${varName} must be a non-empty string of at most ${SECRET_MAX_CHARS} characters`,
				{},
			);
		}
		resolved[name] = value;
	}
	return resolved;
}
