/**
 * Pure bwrap argv builder for clone-workspace sandboxes (P5.2).
 *
 * Mount policy: the sandbox is built by ALLOWLIST, not by deny-list. The
 * host `/` is never bound; instead a fixed set of credential-free system
 * roots is read-only bound (existence-checked and realpath-deduped): the
 * Nix store, the current system profile, `/usr`, `/bin`, `/sbin`, `/lib`,
 * `/lib64`, `/opt`, plus a small allowlist of `/etc` entries (resolver and
 * CA/cert data, locale identity), and the runtime package root (the nearest
 * ancestor of the runtime entry that carries `node_modules/@oh-my-pi`).
 * Operator home, `/home`, `/var`, sibling workspace volumes, every other
 * workspace's provider state, and the clone SOURCE are simply absent from
 * the namespace; the deny-root masks are still applied on top and hide
 * anything under an allowlisted root that resolves into a forbidden area.
 *
 * Per P5.5: operator credentials, the SSH agent, container sockets, and
 * fleet/provider administration state are never mountable; selected model
 * credentials enter ONLY through profile `secretRefs` resolved by the
 * provider and merged after the ambient allowlist, never from the operator
 * environment and never through the request JSON.
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { ProviderProfile } from "./provider-protocol";

/**
 * Thrown when a requested bind source resolves inside a forbidden root
 * (operator home/ssh state, ssh-agent sockets, container sockets, or
 * fleet/provider administration state).
 */
export class DeniedBindError extends Error {
	readonly source: string;
	readonly root: string;
	readonly kind: string;

	constructor(source: string, root: string, kind: string) {
		super(`denied bind source ${source}: inside forbidden root ${root} (${kind})`);
		this.name = "DeniedBindError";
		this.source = source;
		this.root = root;
		this.kind = kind;
	}
}

/** Container/daemon sockets that must never be reachable from a sandbox. */
export const CONTAINER_SOCKET_PATTERNS: readonly string[] = [
	"/var/run/docker.sock",
	"/run/docker.sock",
	"/run/podman/podman.sock",
	"/var/run/podman/podman.sock",
	"/run/containerd/containerd.sock",
	"/var/run/containerd/containerd.sock",
];

/**
 * Forbidden bind roots (P5.5). `operatorHome` is the operator's home
 * directory; the provider derives these from its own environment (HOME,
 * SSH_AUTH_SOCK, the provider script location) once, at request time.
 */
export interface DenyRoots {
	/** Operator home directory. */
	operatorHome: string;
	/** Operator ssh credential dir (join(operatorHome, ".ssh")). */
	sshDir: string;
	/** Fleet administration state (`~/.omp-web`). */
	fleetState: string;
	/** Provider administration state (its own script/config dir). */
	providerState: string;
	/** ssh-agent socket path (SSH_AUTH_SOCK value), when exported and absolute. */
	sshAuthSock: string | null;
	/** Per-user runtime dir (/run/user/<uid>), when uid is known. */
	userRuntimeDir: string | null;
}

/** Everything the argv builder needs. */
export interface BwrapArgsInput {
	/** Workspace checkout directory (rw bind). */
	workspaceDir: string;
	/** Workspace private home directory (rw bind). */
	homeDir: string;
	/** Provider profile; `tools` are extra read-only binds. */
	profile: ProviderProfile;
	/** Identity token; must appear in the sandbox command's argv. */
	workspaceToken: string;
	/** Runtime entry the sandbox runs (absolute path, ro-visible). */
	runtimeEntry: string;
	/** Runtime binary (e.g. bun); absolute, exists inside the sandbox. */
	runtimeBin: string;
	/** Extra fixed argv for the runtime entry (e.g. "session" for the bundle). */
	runtimeArgs?: readonly string[];
	/** Absolute path to the bwrap executable. */
	bwrapBin?: string;
	/** Deny roots supplied by the application from its operator environment and layout. */
	denyRoots: DenyRoots;
	/**
	 * Operator environment snapshot for the ambient env allowlist; never
	 * from the request. Deny roots are supplied separately.
	 */
	env?: Record<string, string | undefined>;
	/**
	 * Selected model credentials resolved from `profile.secretRefs` by the
	 * provider (P5.5). Values merge AFTER the ambient allowlist; they are
	 * the ONLY source for keys outside the allowlist and cannot override any
	 * allowlisted key.
	 */
	secretEnv?: Record<string, string>;
	/**
	 * The clone source's fleet-host path (P4.2: the running sandbox never
	 * mounts the source repository). When provided and distinct from the
	 * workspace volumes, its realpath is masked with an empty tmpfs (or
	 * /dev/null for regular files) so the source stays invisible even where
	 * an allowlisted system root would expose it.
	 */
	sourceLocal?: string;
}

export interface BwrapArgsOutput {
	/** Complete bwrap argv: the only namespace surface. */
	argv: string[];
	/** Whitelisted sandbox environment. */
	env: Record<string, string>;
}

/** Env keys that never enter the sandbox even when the operator exported them. */
export const ENV_DENY_KEYS: readonly string[] = [
	"SSH_AUTH_SOCK",
	"SSH_AGENT_PID",
	"OMP_FLEET_CONFIG",
	"OMP_FLEET_STATE",
	"XDG_RUNTIME_DIR",
	"DBUS_SESSION_BUS_ADDRESS",
];

/**
 * Env keys a sandboxed omp-session needs (callback flags, locale). This is
 * the ONLY ambient-env passthrough: anything absent here cannot enter the
 * sandbox from the operator environment. Credential-shaped keys
 * (PI_AUTH_*, PI_PROFILE, PI_CONFIG_DIR) were intentionally REMOVED; they
 * are model credentials and enter only via `profile.secretRefs`.
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
	// P8.9 wake-resume: fleet-written absolute main-session path; the daemon
	// resumes it at boot (server/config.ts reads OMP_SESSION_RESUME). Rides
	// the callback-env handoff, never the ambient environment.
	"OMP_SESSION_RESUME",
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
	// Env-name shape guard is applied on top; these are the callback/user
	// credential keys that must only ever enter via `callback-env.json` or
	// explicit secretRefs (see provider), never via the request JSON.
	"OMP_SESSION_CALLBACK_URL",
	"OMP_SESSION_CALLBACK_WORKSPACE",
	"OMP_SESSION_CALLBACK_GENERATION",
	"OMP_SESSION_CALLBACK_TOKEN",
	"OMP_SESSION_CALLBACK_PROXY",
	"OMP_SESSION_CALLBACK_ALLOW_HTTP",
];

const DEFAULT_PATH = "/run/current-system/sw/bin:/usr/bin:/bin";

/** Without a trailing separator (so prefix comparisons stay exact). */
function rootSuffix(p: string): string {
	return p.endsWith(sep) ? p.slice(0, -1) : p;
}

/** Realpath when the path exists, else normalized-absolute (for denials). */
function realOrResolve(p: string): string {
	try {
		return rootSuffix(realpathSync(p));
	} catch {
		return rootSuffix(resolve(p));
	}
}

/**
 * Derive the forbidden roots from the operator environment: the operator
 * home, its ssh dir, the fleet state dir (~/.omp-web), the application-supplied
 * provider state dir, and the ssh-agent socket. The agent socket is only a bind
 * concern when it is an absolute path; abstract sockets and relative agent
 * names cannot be mounted and are ignored.
 */
export function deriveDenyRoots(
	env: Record<string, string | undefined>,
	providerState: string,
): DenyRoots {
	const operatorHome = rootSuffix(realOrResolve(env.HOME ?? "/root"));
	const sshAuthSockRaw = env.SSH_AUTH_SOCK;
	const sshAuthSock =
		sshAuthSockRaw !== undefined && sshAuthSockRaw.startsWith("/")
			? rootSuffix(sshAuthSockRaw)
			: null;
	const uid = typeof process.getuid === "function" ? process.getuid() : -1;
	return {
		operatorHome,
		sshDir: rootSuffix(realOrResolve(join(operatorHome, ".ssh"))),
		fleetState: rootSuffix(realOrResolve(join(operatorHome, ".omp-web"))),
		providerState: rootSuffix(realOrResolve(providerState)),
		sshAuthSock,
		userRuntimeDir: uid >= 0 ? `/run/user/${uid}` : null,
	};
}

function assertNotInside(source: string, root: string, kind: string): void {
	if (root.length === 0) return;
	const real = rootSuffix(realOrResolve(source));
	if (real === root || real.startsWith(root + sep)) {
		throw new DeniedBindError(real, root, kind);
	}
}

/**
 * Assert a workspace volume path (checkout or private home) is safe to
 * bind. The workspace volumes are the sanctioned sandbox content; they must
 * never alias operator credentials, sockets, or provider state.
 */
export function assertWorkspaceVolume(source: string, roots: DenyRoots): void {
	if (!isAbsolute(source)) {
		throw new DeniedBindError(source, "", "not an absolute path");
	}
	assertNotInside(source, roots.sshDir, "operator ssh dir");
	assertNotInside(source, roots.providerState, "provider state");
	if (roots.sshAuthSock !== null) {
		const real = rootSuffix(realOrResolve(source));
		if (real === roots.sshAuthSock) {
			throw new DeniedBindError(real, roots.sshAuthSock, "ssh-agent socket");
		}
	}
	for (const sock of CONTAINER_SOCKET_PATTERNS) {
		assertNotInside(source, sock, "container socket");
	}
}

/**
 * Assert a bind source is not inside any denied root. Compares realpaths,
 * so symlinked tools (NixOS /run/current-system/sw/bin/bun) resolve to
 * their store target before the check: the store path, not the
 * user-facing symlink, is what the mount actually exposes.
 */
export function assertAllowedSource(source: string, roots: DenyRoots): void {
	if (!isAbsolute(source)) {
		throw new DeniedBindError(source, "", "not an absolute path");
	}
	assertNotInside(source, roots.operatorHome, "operator home");
	assertNotInside(source, roots.sshDir, "operator ssh dir");
	assertNotInside(source, roots.fleetState, "fleet state");
	assertNotInside(source, roots.providerState, "provider state");
	if (roots.sshAuthSock !== null) {
		const real = rootSuffix(realOrResolve(source));
		if (real === roots.sshAuthSock) {
			throw new DeniedBindError(real, roots.sshAuthSock, "ssh-agent socket");
		}
	}
	for (const sock of CONTAINER_SOCKET_PATTERNS) {
		assertNotInside(source, sock, "container socket");
	}
}

/**
 * Deny roots that exist and are directories. These are masked with an
 * empty tmpfs (a mount needs a directory destination, so socket FILE
 * paths belong in {@link existingDenyFiles}).
 */
export function existingDenyDirs(roots: DenyRoots): string[] {
	const existing: string[] = [];
	for (const root of [
		roots.operatorHome,
		roots.sshDir,
		roots.fleetState,
		roots.providerState,
		roots.userRuntimeDir,
	]) {
		if (root !== null && root.startsWith("/") && existsSync(root)) existing.push(root);
	}
	// Always-masked roots: never reachable even when a bind parent
	// auto-creates them (e.g. `/var/run` from a socket pattern, or `/run`
	// from /run/current-system) and regardless of whether the dir existed on
	// the host. bwrap can tmpfs-mask a nonexistent dest by creating it.
	const always: string[] = [];
	for (const p of ["/var", "/var/run", "/run/user", "/mnt", "/media", "/srv"]) {
		if (p.startsWith("/") && !existing.includes(p)) always.push(p);
	}
	return [...existing, ...always];
}

/**
 * Deny roots that exist and are files (sockets). A mount requires a
 * directory destination, so a file path is hidden by read-only binding
 * /dev/null over it; inside the sandbox the path is no longer a socket.
 */
export function existingDenyFiles(roots: DenyRoots): string[] {
	const existing: string[] = [];
	for (const root of [roots.sshAuthSock, ...CONTAINER_SOCKET_PATTERNS]) {
		if (root !== null && root.startsWith("/") && existsSync(root)) existing.push(rootSuffix(root));
	}
	return existing;
}

function allowedEnv(
	source: Record<string, string | undefined>,
	keys: readonly string[],
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of keys) {
		const v = source[key];
		if (v !== undefined) out[key] = v;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Sandbox file system policy
// ---------------------------------------------------------------------------

/**
 * Credential-free system roots made visible read-only. Existence-checked
 * individually; realpaths are mounted at the REQUESTED path so the sandbox
 * semantics match the operator's expectation (NixOS symlinks resolve to the
 * store, but the requested path is what appears inside).
 */
const SYSTEM_ALLOW_ROOTS: readonly string[] = [
	"/nix/store",
	"/run/current-system",
	"/usr",
	"/usr/local",
	"/bin",
	"/sbin",
	"/lib",
	"/lib64",
	"/opt",
];

/** Selected `/etc` entries (resolver + CA/locale identity), never whole `/etc`. */
const ETC_ALLOW_ENTRIES: readonly string[] = [
	"resolv.conf",
	"hosts",
	"nsswitch.conf",
	"passwd",
	"group",
	"localtime",
	"ssl",
	"pki",
	"ca-certificates",
];

const SECRET_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SECRET_ENV_MAX_CHARS = 4096;

/**
 * The package root the sandbox must see: the nearest ancestor of `entry`
 * that carries `node_modules/@oh-my-pi`, else the nearest ancestor with a
 * `package.json`, else the entry's own directory. Covers the dev checkout
 * (repo root) and the pinned install layout (prefix/install with hoisted
 * externals) without bind-mounting anything credential-bearing.
 */
export function runtimeRootFor(entry: string): string {
	let dir = dirname(resolve(entry));
	for (;;) {
		if (existsSync(join(dir, "node_modules", "@oh-my-pi"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	dir = dirname(resolve(entry));
	for (;;) {
		if (existsSync(join(dir, "package.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return dirname(resolve(entry));
}

function isContained(candidate: string, root: string): boolean {
	const real = realOrResolve(candidate);
	const realRoot = rootSuffix(realOrResolve(root));
	if (real === realRoot) return true;
	return real.startsWith(realRoot + sep);
}

/**
 * Build the bwrap argv + sandbox env.
 *
 * Sandbox layout (allowlist policy):
 * - credential-free system roots + selected `/etc` entries, read-only,
 *   realpath-deduped; the runtime package root; workspace home/checkout rw;
 *   profile `tools` ro (denylist-asserted).
 * - deny-root masks applied afterwards (empty tmpfs over existing denied
 *   dirs, /dev/null over existing denied files); the clone source path is
 *   masked too (P4.2) unless it IS a workspace volume (dev dogfood).
 * - `--unshare-all --die-with-parent --new-session`, chdir into the
 *   checkout, then the runtime entry argv with the identity token last.
 * - P5.7 network knob: `network` mode swaps ONLY the netns share (`--share-net`
 *   after `--unshare-all` re-shares the host network namespace) while
 *   pid/user/ipc isolation stays intact; absent `network` = isolated.
 * - Env: ambient allowlist copy + builder-set values + secretEnv (merged
 *   last, so model credentials from secretRefs are the only non-allowlisted
 *   keys and cannot override any allowlisted one).
 */
export function buildBwrapArgv(input: BwrapArgsInput): BwrapArgsOutput {
	const { workspaceDir, homeDir, profile, workspaceToken } = input;
	if (!isAbsolute(workspaceDir) || !isAbsolute(homeDir)) {
		throw new Error("workspaceDir and homeDir must be absolute paths");
	}
	if (!isAbsolute(input.runtimeEntry)) {
		throw new Error("runtimeEntry must be an absolute path");
	}
	if (workspaceToken.length === 0) {
		throw new Error("workspaceToken must be a non-empty string");
	}
	if (profile.tools.some((t) => t.length === 0)) {
		throw new Error("profile.tools entries must be non-empty paths");
	}
	const roots = input.denyRoots;
	assertWorkspaceVolume(workspaceDir, roots);
	assertWorkspaceVolume(homeDir, roots);

	// Secret env values are the only non-allowlisted keys; shape-check them
	// here so a malformed provider never reaches argv.
	if (input.secretEnv !== undefined) {
		for (const [key, value] of Object.entries(input.secretEnv)) {
			if (!SECRET_ENV_NAME_RE.test(key) || RESERVED_SECRET_ENV_KEYS.includes(key)) {
				throw new Error(`secretEnv key ${key} is not a valid, non-reserved sandbox env name`);
			}
			if (typeof value !== "string" || value.length === 0 || value.length > SECRET_ENV_MAX_CHARS) {
				throw new Error(
					`secretEnv.${key} must be a non-empty string of at most ${SECRET_ENV_MAX_CHARS} chars`,
				);
			}
		}
	}

	const argv: string[] = [input.bwrapBin ?? "bwrap"];
	const bind = (flags: readonly string[], source: string, dest: string) => {
		argv.push(...flags, source, dest);
	};

	// Fresh namespace device/proc/tmp mounts FIRST: bwrap creates these
	// destinations on the empty namespace, and a later ro-bind of a system
	// root must never pin `/dev`/`/proc`/`/tmp` first (bwrap then cannot
	// mount over it). Each of these flags takes ONE argument (the dest).
	argv.push("--dev", "/dev");
	argv.push("--proc", "/proc");
	argv.push("--tmpfs", "/tmp");

	// Allowlist system roots: existence-checked, realpath-deduped. The
	// realpath is mounted at the requested path.
	const mountedReal = new Set<string>();
	const mountRoot = (requested: string): void => {
		if (!existsSync(requested)) return;
		const real = rootSuffix(realOrResolve(requested));
		if (mountedReal.has(real)) return;
		mountedReal.add(real);
		bind(["--ro-bind"], real, requested);
	};
	for (const root of SYSTEM_ALLOW_ROOTS) mountRoot(root);
	for (const entry of ETC_ALLOW_ENTRIES) mountRoot(join("/etc", entry));

	const runtimeRoot = runtimeRootFor(input.runtimeEntry);

	// Deny masks. Under the allowlist the operator home, fleet/provider state,
	// user runtime dir and any container sockets may still be reachable via an
	// allowlisted root (e.g. a /run/current-system bind that contains them, or
	// the dev runtime root sitting under the home). Masking AFTER the system
	// binds hides every denied path; the sanctioned content is re-exposed
	// below so the masks never win over workspace volumes or the runtime.
	for (const denied of existingDenyDirs(roots)) {
		argv.push("--tmpfs", denied);
	}
	for (const deniedFile of existingDenyFiles(roots)) {
		argv.push("--ro-bind", "/dev/null", deniedFile);
	}

	// P4.2: the clone source must be invisible. Mask its realpath when it is
	// not one of the workspace volumes (dev dogfood: source == checkout).
	if (
		input.sourceLocal !== undefined &&
		!isContained(input.sourceLocal, workspaceDir) &&
		!isContained(input.sourceLocal, homeDir) &&
		!isContained(input.sourceLocal, input.runtimeEntry) &&
		!isContained(input.sourceLocal, input.runtimeBin)
	) {
		const real = rootSuffix(realOrResolve(input.sourceLocal));
		if (existsSync(real)) {
			const info = statSync(real);
			if (info.isDirectory()) {
				argv.push("--tmpfs", real);
			} else if (info.isFile() || info.isSocket()) {
				argv.push("--ro-bind", "/dev/null", real);
			}
		}
	}

	// The runtime package root is bound AFTER the deny masks so the sandbox
	// can reach the daemon even when a dev checkout lives under the operator
	// home (the masks are re-covered by this bind at the same path).
	mountRoot(runtimeRoot);
	if (!mountedReal.has(runtimeRoot)) {
		// runtimeRootFor produced a non-existent ancestor; bind its dirname
		// only when it exists (worst case the entry itself is missing and
		// preflight reports it; the sandbox fails to exec otherwise).
		if (existsSync(runtimeRoot))
			bind(["--ro-bind"], rootSuffix(realOrResolve(runtimeRoot)), runtimeRoot);
	}
	// Workspace volumes and profile tools are the sanctioned content; bind
	// them last so nothing below can hide them.
	bind(["--bind"], homeDir, homeDir);
	bind(["--bind"], workspaceDir, workspaceDir);
	for (const tool of profile.tools) {
		assertAllowedSource(tool, roots);
		bind(["--ro-bind"], tool, tool);
	}

	argv.push("--unshare-all", "--die-with-parent", "--new-session", "--chdir", workspaceDir);
	if ((profile.network ?? "isolated") === "host") argv.push("--share-net");
	argv.push("--");
	argv.push(
		input.runtimeBin,
		input.runtimeEntry,
		...(input.runtimeArgs ?? []),
		`--omp-workspace-token=${workspaceToken}`,
	);

	const env = allowedEnv(input.env ?? process.env, ENV_ALLOW_KEYS);
	env.HOME = homeDir;
	if (env.PATH === undefined) env.PATH = DEFAULT_PATH;
	env.PI_CODING_AGENT_DIR = join(homeDir, "agent");
	env.OMP_PROVIDER_PROTO = "1";
	env.OMP_WORKSPACE_DIR = workspaceDir;
	if (input.secretEnv !== undefined) {
		// Merged last by construction; RESERVED_SECRET_ENV_KEYS was enforced
		// above, so nothing with a fixed sandbox meaning can be overridden.
		for (const [key, value] of Object.entries(input.secretEnv)) env[key] = value;
	}

	return { argv, env };
}
