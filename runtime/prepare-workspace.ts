/**
 * Workspace preparation (P4.1–P4.3): resolves and pins the initial commit
 * exactly once, clones it into `.checkout/` with an independent object store,
 * and verifies the completed checkout before recording the init marker.
 *
 * Layout per the frozen contract (docs/clone-contracts.md, "Preparation
 * layout"):
 *
 * - `.omp-workspace-init.json` — the pin (workspaceId, source, resolvedCommit,
 *   branch) is persisted BEFORE the clone so retries reuse the same commit and
 *   never re-resolve; the verified marker (with `initializedAt`/`prepVersion`)
 *   is written only after the checkout passes verification.
 * - `.checkout/` — the working clone. Cloned with `--no-hardlinks`, never
 *   `--shared`, and verified to have no `objects/info/alternates` file, so its
 *   object store is independent of the source. Clone copies committed history
 *   only; uncommitted source files are never transferred.
 *
 * Git is spawned with explicit argv arrays (no shell). This module never
 * mutates git identity or config — the operator's own git config applies.
 */

import { closeSync, existsSync, fsyncSync, openSync, renameSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Subprocess } from "bun";
import { seedSandboxBaseline, type BaselineSeedResult } from "./sandbox-baseline";

/** Marker contract version stamped into a verified init marker. */
export const WORKSPACE_PREP_VERSION = 1;

/** Marker file name per the frozen preparation layout. */
const MARKER_NAME = ".omp-workspace-init.json";
/** Working clone directory name per the frozen preparation layout. */
const CHECKOUT_NAME = ".checkout";

/** Full commit ids are SHA-1 (40) or SHA-256 (64) hex. */
const COMMIT_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/** Clone source: exactly one of `local` (filesystem path) or `remote` (URL). */
export interface WorkspaceSource {
	local?: string;
	remote?: string;
}

/**
 * The pin record: the marker as persisted before the clone starts. A marker
 * file in this shape means "pinned, not yet initialized" — retries reuse
 * `resolvedCommit` instead of resolving again.
 */
export interface WorkspacePin {
	workspaceId: string;
	source: WorkspaceSource;
	/** Full commit id the source was pinned to. */
	resolvedCommit: string;
	branch: string;
}

/** Verified initialization marker (docs/clone-contracts.md "Preparation layout"). */
export interface WorkspaceInitMarker extends WorkspacePin {
	initializedAt: number;
	prepVersion: number;
}

/** Subset of the frozen ledger typed-error vocabulary that preparation raises. */
export type PrepareWorkspaceErrorCode =
	| "invalid_request"
	| "unavailable"
	| "conflict"
	| "provider_failed";

/** Typed preparation failure; `code` is from the frozen ledger vocabulary. */
export class PrepareWorkspaceError extends Error {
	constructor(
		readonly code: PrepareWorkspaceErrorCode,
		message: string,
	) {
		super(message);
	}
}

export interface PrepareWorkspaceOptions {
	/** Roster workspace identity (`dN`); recorded in the marker. */
	workspaceId: string;
	/** Runtime workspace volume root that receives the preparation layout. */
	workspaceRoot: string;
	/** Clone source: exactly one of `local` or `remote`. */
	source: WorkspaceSource;
	/** Branch to create at the pinned commit; defaults to a sanitized workspaceId. */
	branch?: string;
	/** Commit to pin; defaults to the source's HEAD. Retries never re-resolve. */
	revision?: string;
	/** Cooperative cancellation. A mid-clone abort leaves the pin persisted. */
	signal?: AbortSignal;
	/**
	 * Env names the sandbox will carry, i.e. the profile's secretRefs keys.
	 * Used to drop model-role references that cannot resolve in the sandbox;
	 * when omitted, roles are kept as-is.
	 */
	sandboxEnvKeys?: readonly string[];
}

export interface PrepareWorkspaceResult {
	/** Verified init marker (as written to `.omp-workspace-init.json`). */
	marker: WorkspaceInitMarker;
	/** Absolute path of the working clone. */
	checkoutDir: string;
	/** Best-effort seed of the sandbox baseline config into `.home/agent/config.yml`. */
	baselineSeed?: BaselineSeedResult;
}

// ---------------------------------------------------------------------------
// Small path helpers
// ---------------------------------------------------------------------------

/** True when `candidate` equals `root` or is strictly under it (segment-safe). */
function isPathUnder(candidate: string, root: string): boolean {
	if (candidate === root) return true;
	return candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** The single configured source location (validation guarantees exactly one). */
function sourceLocation(source: WorkspaceSource): string {
	if (source.local !== undefined) return source.local;
	if (source.remote !== undefined) return source.remote;
	throw new PrepareWorkspaceError("invalid_request", "source requires one of `local` or `remote`");
}

/** Last non-empty stderr line, for actionable error messages. */
function lastLine(text: string): string {
	const lines = text.trim().split("\n");
	return lines[lines.length - 1]?.trim() ?? "";
}

// ---------------------------------------------------------------------------
// Argument validation / derivation
// ---------------------------------------------------------------------------

/**
 * Derives the default workspace branch from the workspace identity: lowercase,
 * run of characters outside `[a-z0-9._/-]` folded to `-`, trimmed of leading
 * and trailing `[-.]`; empty or `head` falls back to `workspace`.
 */
export function deriveWorkspaceBranch(workspaceId: string): string {
	const derived = workspaceId
		.toLowerCase()
		.replace(/[^a-z0-9._/-]+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "");
	return derived === "" || derived === "head" ? "workspace" : derived;
}

/** Validates a caller-supplied branch name (single ref name, no traversal). */
function validateBranch(branch: string): string {
	if (
		!/^[A-Za-z0-9._/-]+$/.test(branch) ||
		branch.startsWith("-") ||
		branch.startsWith(".") ||
		branch.includes("..") ||
		branch.endsWith("/") ||
		branch.endsWith(".lock")
	) {
		throw new PrepareWorkspaceError(
			"invalid_request",
			`invalid branch name: ${JSON.stringify(branch)}`,
		);
	}
	return branch;
}

/** Validates and normalizes the source: exactly one of `local`/`remote`; `local` becomes absolute. */
function normalizeSource(source: unknown): WorkspaceSource {
	if (typeof source !== "object" || source === null) {
		throw new PrepareWorkspaceError(
			"invalid_request",
			"source must be an object with one of `local` or `remote`",
		);
	}
	const raw = source as Record<string, unknown>;
	const { local, remote } = raw;
	const hasLocal = typeof local === "string" && local.trim() !== "";
	const hasRemote = typeof remote === "string" && remote.trim() !== "";
	if ((local !== undefined && !hasLocal) || (remote !== undefined && !hasRemote)) {
		throw new PrepareWorkspaceError(
			"invalid_request",
			"source.local/source.remote must be non-empty strings when given",
		);
	}
	if (hasLocal && hasRemote) {
		throw new PrepareWorkspaceError(
			"invalid_request",
			"source must set exactly one of `local` or `remote`",
		);
	}
	if (!hasLocal && !hasRemote) {
		throw new PrepareWorkspaceError(
			"invalid_request",
			"source requires one of `local` or `remote`",
		);
	}
	return hasLocal ? { local: resolve(local as string) } : { remote: remote as string };
}

/** Parses the optional `revision`; empty/whitespace is rejected. */
function normalizeRevision(revision: string | undefined): string | undefined {
	if (revision === undefined) return undefined;
	if (typeof revision !== "string" || revision.trim() === "") {
		throw new PrepareWorkspaceError(
			"invalid_request",
			"revision must be a non-empty string when given",
		);
	}
	return revision;
}

// ---------------------------------------------------------------------------
// Git shelling (explicit argv, never a shell)
// ---------------------------------------------------------------------------

/** Result of one `git -C <cwd> <args>` invocation. */
interface GitResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	/** True when the git binary itself could not be spawned. */
	spawnFailed?: boolean;
}

/**
 * `git -C <cwd> <args>` via Bun.spawn with explicit argv — never a shell.
 * `GIT_TERMINAL_PROMPT=0` keeps remote contacts non-interactive; the rest of
 * the environment is inherited untouched, so the operator's git config,
 * credentials, and identity apply.
 */
async function runGit(args: string[], cwd: string, signal?: AbortSignal): Promise<GitResult> {
	let proc: Subprocess;
	try {
		proc = Bun.spawn(["git", "-C", cwd, ...args], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		});
	} catch (err) {
		// Bun.spawn throws synchronously when the binary cannot be spawned.
		return { exitCode: 127, stdout: "", stderr: String(err), spawnFailed: true };
	}
	const onAbort = (): void => {
		proc.kill();
	};
	if (signal) signal.addEventListener("abort", onAbort, { once: true });
	try {
		const [stdout, stderr] = await Promise.all([
			// stdout/stderr are configured "pipe" above; Bun's types keep the
			// fd-number union, so narrow explicitly.
			Bun.readableStreamToText(proc.stdout as ReadableStream<Uint8Array>),
			Bun.readableStreamToText(proc.stderr as ReadableStream<Uint8Array>),
		]);
		return { exitCode: await proc.exited, stdout, stderr };
	} catch (err) {
		return { exitCode: 127, stdout: "", stderr: String(err), spawnFailed: true };
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}

/** The git binary itself was unusable — environment problem, `unavailable`. */
function requireGitRan(op: string, res: GitResult): void {
	if (res.spawnFailed) {
		throw new PrepareWorkspaceError(
			"unavailable",
			`git is not available to ${op}: ${lastLine(res.stderr)}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Marker IO (atomic write, fsync file + dir per the ledger durability rule)
// ---------------------------------------------------------------------------

function writeMarker(workspaceRoot: string, value: WorkspacePin | WorkspaceInitMarker): void {
	const path = join(workspaceRoot, MARKER_NAME);
	const tmp = `${path}.tmp-${randomUUID()}`;
	const fd = openSync(tmp, "w");
	try {
		writeSync(fd, `${JSON.stringify(value, null, "\t")}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
	try {
		const dirFd = openSync(workspaceRoot, "r");
		try {
			fsyncSync(dirFd);
		} finally {
			closeSync(dirFd);
		}
	} catch {
		// Some filesystems refuse directory fsync; best-effort durability.
	}
}

/** Parses the optional `source` object inside a persisted marker. */
function asWorkspaceSource(value: unknown): WorkspaceSource | null {
	if (typeof value !== "object" || value === null) return null;
	const raw = value as Record<string, unknown>;
	const { local, remote } = raw;
	if (local !== undefined && typeof local !== "string") return null;
	if (remote !== undefined && typeof remote !== "string") return null;
	if (typeof local !== "string" && typeof remote !== "string") return null;
	return {
		...(local !== undefined ? { local } : {}),
		...(remote !== undefined ? { remote } : {}),
	};
}

type MarkerRead =
	| { state: "absent" }
	| { state: "corrupt" }
	| { state: "pin"; pin: WorkspacePin }
	| { state: "marker"; marker: WorkspaceInitMarker };

/**
 * Reads the init marker. A file with pin fields but no `initializedAt`/
 * `prepVersion` is a pre-clone pin; with them, a verified marker. Anything
 * unparseable or shape-invalid is `corrupt` (never silently reset).
 */
async function readMarker(markerPath: string): Promise<MarkerRead> {
	let raw: string;
	try {
		raw = await readFile(markerPath, "utf8");
	} catch {
		return { state: "absent" };
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return { state: "corrupt" };
	}
	if (typeof value !== "object" || value === null) return { state: "corrupt" };
	const fields = value as Record<string, unknown>;
	const workspaceId = fields["workspaceId"];
	const resolvedCommit = fields["resolvedCommit"];
	const branch = fields["branch"];
	const source = asWorkspaceSource(fields["source"]);
	if (
		typeof workspaceId !== "string" ||
		workspaceId === "" ||
		typeof resolvedCommit !== "string" ||
		!COMMIT_RE.test(resolvedCommit) ||
		typeof branch !== "string" ||
		branch === "" ||
		source === null
	) {
		return { state: "corrupt" };
	}
	const initializedAt = fields["initializedAt"];
	const prepVersion = fields["prepVersion"];
	if (initializedAt === undefined && prepVersion === undefined) {
		return { state: "pin", pin: { workspaceId, source, resolvedCommit, branch } };
	}
	if (
		typeof initializedAt !== "number" ||
		!Number.isFinite(initializedAt) ||
		typeof prepVersion !== "number"
	) {
		return { state: "corrupt" };
	}
	return {
		state: "marker",
		marker: { workspaceId, source, resolvedCommit, branch, initializedAt, prepVersion },
	};
}

/** Human-readable source for messages. */
function describeSource(source: WorkspaceSource): string {
	return source.local !== undefined ? `local ${source.local}` : `remote ${source.remote}`;
}

/**
 * Refuses to run against a marker whose identity (workspaceId, branch,
 * source) differs from the request — the pin belongs to that configuration.
 */
function assertMarkerIdentity(
	stored: WorkspacePin,
	expected: { workspaceId: string; source: WorkspaceSource; branch: string },
): void {
	if (stored.workspaceId !== expected.workspaceId) {
		throw new PrepareWorkspaceError(
			"conflict",
			`workspace ${expected.workspaceId} cannot reuse this init marker: it belongs to workspace ${stored.workspaceId}`,
		);
	}
	if (stored.branch !== expected.branch) {
		throw new PrepareWorkspaceError(
			"conflict",
			`workspace is already prepared on branch "${stored.branch}"; refusing branch "${expected.branch}"`,
		);
	}
	if (
		stored.source.local !== expected.source.local ||
		stored.source.remote !== expected.source.remote
	) {
		throw new PrepareWorkspaceError(
			"conflict",
			`workspace was pinned from a different source (${describeSource(stored.source)}), refusing ${describeSource(expected.source)}`,
		);
	}
}

/**
 * A request that names an explicit revision must agree with the persisted
 * pin. Full-sha requests compare without touching the source; ref names are
 * resolved in the source to check they point at the pin.
 */
async function assertPinSatisfiesRevision(
	source: WorkspaceSource,
	pin: string,
	revision: string | undefined,
	workspaceRoot: string,
	signal?: AbortSignal,
): Promise<void> {
	if (revision === undefined) return;
	if (COMMIT_RE.test(revision)) {
		if (revision !== pin) {
			throw new PrepareWorkspaceError(
				"conflict",
				`workspace is already pinned to ${pin}; refusing requested revision ${revision}`,
			);
		}
		return;
	}
	const resolved = await resolvePin(source, revision, workspaceRoot, signal);
	if (resolved !== pin) {
		throw new PrepareWorkspaceError(
			"conflict",
			`workspace is already pinned to ${pin}; requested ${revision} resolves to ${resolved}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Pin resolution / verification
// ---------------------------------------------------------------------------

/** One advertised ref from `git ls-remote`. */
interface RemoteRef {
	oid: string;
	ref: string;
}

/** Parses `git ls-remote` output into advertised refs. */
function parseLsRemote(stdout: string): RemoteRef[] {
	return stdout.split("\n").flatMap((line) => {
		const tab = line.indexOf("\t");
		if (tab <= 0) return [];
		const oid = line.slice(0, tab).trim();
		const ref = line.slice(tab + 1).trim();
		return oid !== "" && ref !== "" ? [{ oid, ref }] : [];
	});
}

/**
 * Picks the full commit id for `revision` (or HEAD) from advertised refs:
 * exact/prefixed oid match, then `refs/heads/<rev>`, then `refs/tags/<rev>`
 * (preferring the peeled commit), then a unique refname tail match.
 */
function pickRemoteCommit(refs: RemoteRef[], source: string, revision: string | undefined): string {
	if (revision === undefined) {
		const head = refs.find((r) => r.ref === "HEAD");
		if (!head) {
			throw new PrepareWorkspaceError(
				"unavailable",
				`remote source ${source} offers no HEAD to pin`,
			);
		}
		return head.oid;
	}
	if (COMMIT_RE.test(revision)) {
		if (refs.some((r) => r.oid === revision)) return revision;
		const prefixes = refs.filter((r) => r.oid.startsWith(revision));
		if (prefixes.length === 1) return prefixes[0]!.oid;
		if (prefixes.length > 1) {
			throw new PrepareWorkspaceError(
				"invalid_request",
				`revision ${revision} is an ambiguous oid prefix on ${source} (${prefixes.map((r) => r.ref).join(", ")})`,
			);
		}
		throw new PrepareWorkspaceError(
			"unavailable",
			`remote source ${source} does not offer ${revision}`,
		);
	}
	const branch = refs.find((r) => r.ref === `refs/heads/${revision}`);
	if (branch) return branch.oid;
	const tag = refs.find((r) => r.ref === `refs/tags/${revision}`);
	if (tag) {
		// Prefer the peeled commit of an annotated tag over the tag object.
		const peeled = refs.find((r) => r.ref === `refs/tags/${revision}{}`);
		return peeled ? peeled.oid : tag.oid;
	}
	const tail = refs.filter((r) => r.ref.endsWith(`/${revision}`));
	if (tail.length === 1) return tail[0]!.oid;
	if (tail.length > 1) {
		throw new PrepareWorkspaceError(
			"invalid_request",
			`revision ${revision} is ambiguous on ${source} (${tail.map((r) => r.ref).join(", ")})`,
		);
	}
	throw new PrepareWorkspaceError(
		"unavailable",
		`remote source ${source} does not offer ${revision}`,
	);
}

/**
 * Resolves the pin to a full commit id. Local sources resolve any commit-ish
 * with `rev-parse --verify <rev>^{commit}`; remote sources resolve against
 * advertised refs only. Nothing is offered → `unavailable`.
 */
async function resolvePin(
	source: WorkspaceSource,
	revision: string | undefined,
	workspaceRoot: string,
	signal?: AbortSignal,
): Promise<string> {
	if (source.local !== undefined) {
		const src = source.local;
		const probe = await runGit(
			["rev-parse", "--verify", `${revision ?? "HEAD"}^{commit}`],
			src,
			signal,
		);
		requireGitRan("read the local source", probe);
		if (probe.exitCode !== 0) {
			throw new PrepareWorkspaceError(
				"unavailable",
				`local source ${src} does not offer ${revision ?? "HEAD"} to pin: ${lastLine(probe.stderr || probe.stdout)}`,
			);
		}
		return probe.stdout.trim();
	}
	const remote = sourceLocation(source);
	const listing = await runGit(["ls-remote", remote], workspaceRoot, signal);
	requireGitRan("contact the remote source", listing);
	if (listing.exitCode !== 0) {
		throw new PrepareWorkspaceError(
			"unavailable",
			`remote source ${remote} is unreachable: ${lastLine(listing.stderr || listing.stdout)}`,
		);
	}
	return pickRemoteCommit(parseLsRemote(listing.stdout), remote, revision);
}

/**
 * Re-verifies that the source still offers the pinned commit before any
 * clone. An unreachable local commit or unadvertised remote commit is
 * `unavailable` — the pin is never silently replaced by upstream state.
 */
async function verifyPinInSource(
	source: WorkspaceSource,
	pin: string,
	workspaceRoot: string,
	signal?: AbortSignal,
): Promise<void> {
	if (source.local !== undefined) {
		const probe = await runGit(["cat-file", "-e", `${pin}^{commit}`], source.local, signal);
		requireGitRan("read the local source", probe);
		if (probe.exitCode !== 0) {
			throw new PrepareWorkspaceError(
				"unavailable",
				`local source ${source.local} does not offer pinned commit ${pin}; refusing to substitute upstream state: ${lastLine(probe.stderr || probe.stdout)}`,
			);
		}
		return;
	}
	const remote = sourceLocation(source);
	const listing = await runGit(["ls-remote", remote], workspaceRoot, signal);
	requireGitRan("contact the remote source", listing);
	if (listing.exitCode !== 0) {
		throw new PrepareWorkspaceError(
			"unavailable",
			`remote source ${remote} is unreachable: ${lastLine(listing.stderr || listing.stdout)}`,
		);
	}
	if (!parseLsRemote(listing.stdout).some((r) => r.oid === pin)) {
		throw new PrepareWorkspaceError(
			"unavailable",
			`remote source ${remote} does not offer pinned commit ${pin}; refusing to substitute upstream state`,
		);
	}
}

// ---------------------------------------------------------------------------
// Clone + verification
// ---------------------------------------------------------------------------

/** True when `.checkout` holds a complete, independent clone at `pin`. */
async function checkoutIsValid(checkoutDir: string, pin: string): Promise<boolean> {
	const head = await runGit(["rev-parse", "HEAD"], checkoutDir);
	if (head.exitCode !== 0 || head.stdout.trim() !== pin) return false;
	const object = await runGit(["cat-file", "-e", `${pin}^{commit}`], checkoutDir);
	if (object.exitCode !== 0) return false;
	return !existsSync(join(checkoutDir, ".git", "objects", "info", "alternates"));
}

/**
 * Clones the source into `.checkout` (wiping any invalid partial state),
 * creates `branch` at `pin`, verifies the completed checkout, and writes the
 * verified marker last.
 */
async function cloneAndFinalize(params: {
	workspaceId: string;
	source: WorkspaceSource;
	branch: string;
	pin: string;
	workspaceRoot: string;
	checkoutDir: string;
	signal?: AbortSignal;
	sandboxEnvKeys?: readonly string[];
}): Promise<PrepareWorkspaceResult> {
	const { workspaceId, source, branch, pin, workspaceRoot, checkoutDir, signal, sandboxEnvKeys } =
		params;
	signal?.throwIfAborted();
	await rm(checkoutDir, { recursive: true, force: true });
	const src = sourceLocation(source);

	const clone = await runGit(
		// Independent object store: no hardlinks to the source, never --shared.
		["clone", "--no-hardlinks", "--no-checkout", src, checkoutDir],
		workspaceRoot,
		signal,
	);
	signal?.throwIfAborted(); // mid-clone kill: pin stays persisted, retry re-clones
	requireGitRan("clone the source", clone);
	if (clone.exitCode !== 0) {
		throw new PrepareWorkspaceError(
			"unavailable",
			`cloning ${src} into ${checkoutDir} failed: ${lastLine(clone.stderr || clone.stdout)}`,
		);
	}

	const co = await runGit(["checkout", "-B", branch, pin], checkoutDir, signal);
	signal?.throwIfAborted();
	requireGitRan("check out the pinned commit", co);
	if (co.exitCode !== 0) {
		throw new PrepareWorkspaceError(
			"provider_failed",
			`checking out pinned commit ${pin} on branch "${branch}" failed: ${lastLine(co.stderr || co.stdout)}`,
		);
	}

	// Verify the completed checkout: HEAD is exactly the pin and the object
	// store stayed independent (no alternates to the source).
	const head = await runGit(["rev-parse", "HEAD"], checkoutDir, signal);
	requireGitRan("verify the checkout", head);
	if (head.exitCode !== 0 || head.stdout.trim() !== pin) {
		throw new PrepareWorkspaceError(
			"provider_failed",
			`checkout verification failed: HEAD is ${head.stdout.trim() || "(unresolvable)"}, expected pinned ${pin}`,
		);
	}
	if (existsSync(join(checkoutDir, ".git", "objects", "info", "alternates"))) {
		throw new PrepareWorkspaceError(
			"provider_failed",
			"clone produced a linked object store (objects/info/alternates); the checkout object store must be independent",
		);
	}

	const marker: WorkspaceInitMarker = {
		workspaceId,
		source,
		resolvedCommit: pin,
		branch,
		initializedAt: Date.now(),
		prepVersion: WORKSPACE_PREP_VERSION,
	};

	// Seed the sandbox baseline config into `.home/agent/config.yml` once the
	// checkout is verified but before the marker lands: seedSandboxBaseline is
	// best-effort (never throws) and never overwrites an existing target file.
	const baselineSeed = await seedSandboxBaseline(workspaceRoot, { sandboxEnvKeys });
	writeMarker(workspaceRoot, marker);
	return { marker, checkoutDir, baselineSeed };
}

// ---------------------------------------------------------------------------
// Pin resolution (fleet-owned; shared with provider-side-init profiles)
// ---------------------------------------------------------------------------

export interface ResolveWorkspacePinOptions {
	/** Git must run inside a directory (remote ls-remote needs one). */
	cwd?: string;
	/** Cooperative cancellation. */
	signal?: AbortSignal;
}

/**
 * Resolve a requested revision (or the source HEAD) to a full commit id
 * WITHOUT modifying anything: local sources `rev-parse --verify
 * <rev>^{commit}`, remote sources resolve against advertised refs only and
 * refuse an unoffered commit. This is the fleet-owned pin resolution —
 * the k8s provider never resolves; `createClone` calls this ONCE for every
 * profile and persists the full commit as `pinnedRevision` before any
 * provider-side init, so in-pod preparation always reuses the same pin.
 *
 * Throws {@link PrepareWorkspaceError} with the frozen ledger codes
 * (`invalid_request` for malformed revisions, `unavailable` when the source
 * does not offer the commit).
 */
export async function resolveWorkspacePin(
	source: WorkspaceSource,
	revision?: string,
	options?: ResolveWorkspacePinOptions,
): Promise<string> {
	const normalized = normalizeSource(source);
	const rev = normalizeRevision(revision);
	return resolvePin(normalized, rev, options?.cwd ?? process.cwd(), options?.signal);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Prepares a managed clone workspace under `workspaceRoot`:
 *
 * 1. Resolves and pins the initial commit exactly once and persists the pin
 *    to `.omp-workspace-init.json` BEFORE cloning; every retry reuses the
 *    persisted pin and never re-resolves.
 * 2. Verifies the source still offers the pinned commit (`cat-file`/`ls-remote`);
 *    an unoffered commit is `unavailable`, never silently replaced by upstream.
 * 3. Clones into `.checkout/` with an independent object store
 *    (`--no-hardlinks`, no alternates) and creates `branch` at the pin.
 * 4. Verifies `rev-parse HEAD` equals the pin, seeds the sandbox baseline
 *    config into `.home/agent/config.yml` (best-effort, never overwrites an
 *    existing file), and writes the verified marker (with
 *    `initializedAt`/`prepVersion`) last.
 *
 * Retry-safe: a missing marker or invalid checkout re-runs against the same
 * pin; a valid initialized workspace is an idempotent no-op returning the
 * existing marker. Git identity/config is never mutated.
 */
export async function prepareWorkspace(
	options: PrepareWorkspaceOptions,
): Promise<PrepareWorkspaceResult> {
	options.signal?.throwIfAborted();
	const workspaceId = options.workspaceId;
	if (typeof workspaceId !== "string" || workspaceId.trim() === "") {
		throw new PrepareWorkspaceError("invalid_request", "workspaceId is required");
	}
	if (typeof options.workspaceRoot !== "string" || options.workspaceRoot.trim() === "") {
		throw new PrepareWorkspaceError("invalid_request", "workspaceRoot is required");
	}
	const source = normalizeSource(options.source);
	const branch =
		options.branch === undefined
			? deriveWorkspaceBranch(workspaceId)
			: validateBranch(options.branch);
	const revision = normalizeRevision(options.revision);
	const workspaceRoot = options.workspaceRoot;
	const markerPath = join(workspaceRoot, MARKER_NAME);
	const checkoutDir = join(workspaceRoot, CHECKOUT_NAME);

	if (source.local !== undefined) {
		// Preparing into the source repo itself would nest repositories.
		const local = resolve(source.local);
		if (isPathUnder(checkoutDir, local) || isPathUnder(local, checkoutDir)) {
			throw new PrepareWorkspaceError(
				"conflict",
				`workspace root ${workspaceRoot} overlaps the local source ${local}`,
			);
		}
	}

	try {
		await mkdir(workspaceRoot, { recursive: true });
	} catch (err) {
		throw new PrepareWorkspaceError(
			"unavailable",
			`workspace root ${workspaceRoot} is unusable: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	const read = await readMarker(markerPath);

	if (read.state === "corrupt") {
		// Unknown state with an existing checkout must not be destroyed.
		if (existsSync(checkoutDir)) {
			throw new PrepareWorkspaceError(
				"conflict",
				`${markerPath} is unparseable but ${CHECKOUT_NAME}/ exists; resolve manually before retrying`,
			);
		}
	}

	if (read.state === "marker") {
		const stored = read.marker;
		assertMarkerIdentity(stored, { workspaceId, source, branch });
		await assertPinSatisfiesRevision(
			source,
			stored.resolvedCommit,
			revision,
			workspaceRoot,
			options.signal,
		);
		if (await checkoutIsValid(checkoutDir, stored.resolvedCommit)) {
			// Valid initialized workspace: never reset or re-cloned.
			//
			// Volumes prepared before baseline seeding hold a valid marker and
			// would never be re-seeded on later runs; attempt the seed here so
			// those volumes converge on the first post-upgrade run. The call
			// self-guards via its target-exists check, so an already-booted or
			// user-edited config is never clobbered.
			const baselineSeed = await seedSandboxBaseline(workspaceRoot, {
				sandboxEnvKeys: options.sandboxEnvKeys,
			});
			return { marker: stored, checkoutDir, baselineSeed };
		}
		// Checkout invalid (partial clone, wrong HEAD): the source must still
		// offer the SAME pin before anything is re-cloned.
		await verifyPinInSource(source, stored.resolvedCommit, workspaceRoot, options.signal);
		return cloneAndFinalize({
			workspaceId: stored.workspaceId,
			source: stored.source,
			branch: stored.branch,
			pin: stored.resolvedCommit,
			workspaceRoot,
			checkoutDir,
			signal: options.signal,
			sandboxEnvKeys: options.sandboxEnvKeys,
		});
	}

	let pin: string;
	if (read.state === "pin") {
		assertMarkerIdentity(read.pin, { workspaceId, source, branch });
		pin = read.pin.resolvedCommit;
		await assertPinSatisfiesRevision(source, pin, revision, workspaceRoot, options.signal);
	} else {
		pin = await resolvePin(source, revision, workspaceRoot, options.signal);
	}

	// The source must still offer the pin before anything is cloned.
	await verifyPinInSource(source, pin, workspaceRoot, options.signal);
	// Pin persisted BEFORE the clone; retries reuse it, never re-resolve.
	writeMarker(workspaceRoot, { workspaceId, source, resolvedCommit: pin, branch });
	return cloneAndFinalize({
		workspaceId,
		source,
		branch,
		pin,
		workspaceRoot,
		checkoutDir,
		signal: options.signal,
		sandboxEnvKeys: options.sandboxEnvKeys,
	});
}
