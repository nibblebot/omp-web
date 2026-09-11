/**
 * Sandbox environment policy: the single authority for which environment
 * names cross into a sandboxed session.
 *
 * `ENV_ALLOW_KEYS` is the ONLY ambient passthrough for the bwrap sandbox:
 * anything absent from it cannot enter from the operator environment.
 * `CALLBACK_ENV_KEYS` is the exact allowlist for the fleet-written
 * `callback-env.json` handoff (runtime/callback-env.ts); the wake-resume
 * names ride that handoff. `RESERVED_SECRET_ENV_KEYS` names the fixed
 * sandbox meanings a profile `secretRef` may never override, and
 * `KUBERNETES_RESERVED_ENV_KEYS` adds the Pod-owned names the Kubernetes
 * provider injects itself.
 */

/** Callback-handoff env names: the exact `callback-env.json` allowlist. */
export const CALLBACK_ENV_KEYS: readonly string[] = [
	"OMP_SESSION_CALLBACK_URL",
	"OMP_SESSION_CALLBACK_WORKSPACE",
	"OMP_SESSION_CALLBACK_GENERATION",
	"OMP_SESSION_CALLBACK_TOKEN",
	"OMP_SESSION_CALLBACK_PROXY",
	"OMP_SESSION_CALLBACK_ALLOW_HTTP",
	// P8.9 wake-resume: fleet-written session path the daemon resumes at boot
	// (server/config.ts reads OMP_SESSION_RESUME). The REQUIRED flag makes a
	// missing target fail the boot instead of silently starting a fresh
	// session; both are handoff-only, never ambient.
	"OMP_SESSION_RESUME",
	"OMP_SESSION_RESUME_REQUIRED",
];

/**
 * Env keys a sandboxed omp-session may inherit from the operator
 * environment. Credential-shaped keys (PI_AUTH_*, PI_PROFILE, PI_CONFIG_DIR)
 * are intentionally absent — they are model credentials and enter only via
 * `profile.secretRefs`.
 */
export const ENV_ALLOW_KEYS: readonly string[] = [
	"HOME",
	"PATH",
	"TERM",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TZ",
	"NO_COLOR",
	"OMP_SESSION",
	"OMP_SESSION_LISTEN",
	"OMP_SESSION_ENDPOINT",
	"OMP_SESSION_CALLBACK_URL",
	"OMP_SESSION_CALLBACK_WORKSPACE",
	"OMP_SESSION_CALLBACK_GENERATION",
	"OMP_SESSION_CALLBACK_TOKEN",
	"OMP_SESSION_CALLBACK_PROXY",
	"OMP_SESSION_CALLBACK_ALLOW_HTTP",
	// Ambient OMP_SESSION_RESUME predates the handoff split.
	"OMP_SESSION_RESUME",
	// OMP_SESSION_RESUME_REQUIRED is deliberately absent: an operator-exported
	// flag would fail every sandbox boot whose handoff names no resume target.
	"OMP_WORKSPACE_ID",
	"OMP_WORKSPACE_DIR",
	"OMP_WORKSPACE_GENERATION",
	"OMP_PROVIDER_PROTO",
	"OMP_AGENT_DIR",
	"PI_EXPORT",
	"PI_SESSION_ID",
];

/** Keys with a fixed sandbox meaning that a secretRef may never override. */
export const RESERVED_SECRET_ENV_KEYS: readonly string[] = [
	...ENV_ALLOW_KEYS,
	// Handoff-only (not ambient): a secretRef must not shadow it either.
	"OMP_SESSION_RESUME_REQUIRED",
];

/**
 * Env names the Kubernetes provider owns on a Pod: the injected container env
 * (workspace identity, preparation pin, home/path/locale, provider version,
 * idle timeout, baseline config, image-owned SSH wrapper) plus the callback
 * handoff. A profile secretRef may never shadow one.
 */
export const KUBERNETES_RESERVED_ENV_KEYS: readonly string[] = [
	"OMP_WORKSPACE_ROOT",
	"OMP_WORKSPACE_DIR",
	"OMP_WORKSPACE_ID",
	"OMP_WORKSPACE_GENERATION",
	"OMP_WORKSPACE_TOKEN",
	"OMP_PREP_SOURCE_REMOTE",
	"OMP_PREP_REVISION",
	"OMP_PREP_BRANCH",
	"HOME",
	"PATH",
	"LANG",
	"TERM",
	"PI_CODING_AGENT_DIR",
	"OMP_PROVIDER_PROTO",
	"OMP_SESSION_IDLE_TIMEOUT",
	"GIT_SSH_COMMAND",
	"OMP_SANDBOX_BASELINE_CONFIG",
	...CALLBACK_ENV_KEYS,
];
